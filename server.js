// server.js - Fixed implementation with proper user creation and assignment
const express = require('express');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const crypto = require('crypto');

const app = express();

// Validate environment variables
const validateEnvVars = () => {
  const requiredVars = [
    'STRIPE_SECRET_KEY',
    'PTERODACTYL_BASE',
    'PTERODACTYL_API_KEY',
    'MaxServersPerNode',
    'PTERODACTYL_NODE_ID',
    'PTERODACTYL_EGG_ID'
  ];
  
  const missingVars = requiredVars.filter(varName => !process.env[varName]);
  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
};

validateEnvVars();

// Pterodactyl configuration
const PTERODACTYL_BASE = process.env.PTERODACTYL_BASE;
const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;
const MaxServersPerNode = parseInt(process.env.MaxServersPerNode) || 50;
const nodeId = process.env.PTERODACTYL_NODE_ID;

// Helper function to make authenticated requests to Pterodactyl
const pterodactylRequest = async (method, endpoint, data = null) => {
  const config = {
    method,
    url: `${PTERODACTYL_BASE}${endpoint}`,
    headers: {
      'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  };
  
  if (data) {
    config.data = data;
  }
  
  try {
    const response = await axios(config);
    return response;
  } catch (error) {
    console.error(`❌ Pterodactyl API Error [${method} ${endpoint}]:`, {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    throw error;
  }
};

// Improved CreateUser function with better error handling
const CreateUser = async (email) => {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('Invalid email address provided');
  }

  try {
    console.log(`🔍 Searching for existing user with email: ${email}`);
    
    // STEP 1: Search for existing user
    const searchResponse = await pterodactylRequest(
      'GET', 
      `/users?filter[email]=${encodeURIComponent(email)}`
    );
    
    if (searchResponse.data.data.length > 0) {
      const existingUser = searchResponse.data.data[0].attributes;
      console.log("✅ Found existing user:", existingUser.username);
      return {
        success: true,
        userId: existingUser.id,
        username: existingUser.username,
        email: existingUser.email,
        existing: true
      };
    }
    
    // STEP 2: Create new user if not found
    console.log("🆕 Creating new user for email:", email);
    
    // Generate clean username and password
    const username = generateUsernameFromEmail(email);
    const password = generateRandomPassword(16);
    
    const userData = {
      email: email,
      username: username,
      first_name: username.charAt(0).toUpperCase() + username.slice(1),
      last_name: "User",
      password: password,
      root_admin: false,
      language: "en"
    };
    
    console.log("🔧 Creating user with data:", { ...userData, password: '[HIDDEN]' });
    
    const response = await pterodactylRequest('POST', '/users', userData);
    
    console.log("✅ User created successfully:", response.data.attributes.username);
    return {
      success: true,
      userId: response.data.attributes.id,
      username: response.data.attributes.username,
      email: response.data.attributes.email,
      password: password, // Include password for new users
      existing: false
    };
    
  } catch (error) {
    console.error("❌ User creation error:", {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
    
    // Handle 422 (validation errors) specifically
    if (error.response?.status === 422) {
      const errors = error.response?.data?.errors || [];
      console.log("📋 Validation errors:", errors);
      
      // Check if user already exists (race condition)
      if (errors.some(e => e.detail?.includes('already exists') || e.detail?.includes('taken'))) {
        console.log("🔄 User might exist due to race condition, searching again...");
        try {
          const finalSearch = await pterodactylRequest(
            'GET',
            `/users?filter[email]=${encodeURIComponent(email)}`
          );
          
          if (finalSearch.data.data.length > 0) {
            const user = finalSearch.data.data[0].attributes;
            console.log("✅ Found user after race condition:", user.username);
            return {
              success: true,
              userId: user.id,
              username: user.username,
              email: user.email,
              existing: true
            };
          }
        } catch (finalError) {
          console.error("❌ Final search failed:", finalError.message);
        }
      }
    }
    
    throw new Error(`Failed to create/find user: ${error.message}`);
  }
};

// Helper function to generate username from email
function generateUsernameFromEmail(email) {
  const baseUsername = email.split('@')[0]
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .slice(0, 12); // Leave room for random suffix
  
  const randomSuffix = Math.floor(Math.random() * 9999).toString().padStart(4, '0');
  return `${baseUsername}${randomSuffix}`;
}

// Generate secure password
function generateRandomPassword(length = 16) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  const randomBytes = crypto.randomBytes(length);
  let password = '';
  
  for (let i = 0; i < length; i++) {
    password += charset[randomBytes[i] % charset.length];
  }
  
  return password;
}

// Fixed server limit checking
const checkServerLimits = async () => {
  try {
    console.log(`🔄 Checking server limits on node ${nodeId}`);
    
    const response = await pterodactylRequest('GET', `/nodes/${nodeId}/servers`);
    
    const currentServers = response.data.data.length;
    console.log(`📊 Current servers: ${currentServers}/${MaxServersPerNode}`);
    
    if (currentServers >= MaxServersPerNode) {
      throw new Error(`Server limit reached (${currentServers}/${MaxServersPerNode})`);
    }
    
    return { currentServers, maxServers: MaxServersPerNode };
  } catch (err) {
    console.error('❌ Server limit check failed:', err.message);
    throw new Error(`Server limit validation failed: ${err.message}`);
  }
};

// Get available allocation
const getAvailableAllocation = async (nodeId) => {
  try {
    console.log(`🔍 Looking for available allocation on node ${nodeId}`);
    
    const response = await pterodactylRequest('GET', `/nodes/${nodeId}/allocations`);
    
    const availableAllocations = response.data.data.filter(a => !a.attributes.assigned);
    
    if (availableAllocations.length === 0) {
      throw new Error('No available server ports/allocations on this node');
    }
    
    const allocation = availableAllocations[0];
    console.log(`✅ Found available allocation: ${allocation.attributes.ip}:${allocation.attributes.port}`);
    
    return allocation;
  } catch (error) {
    console.error('❌ Failed to get allocation:', error.message);
    throw error;
  }
};

// Main server creation function with proper user assignment
async function createPterodactylServer(session) {
  try {
    console.log('🚀 Starting server creation process');
    console.log('📋 Session data:', JSON.stringify({
      id: session.id,
      customer_details: session.customer_details,
      metadata: session.metadata
    }, null, 2));
    
    // Validate session
    if (!session || typeof session !== 'object') {
      throw new Error('Invalid session data');
    }
    
    // Get customer email with proper validation
    const customerEmail = session.customer_details?.email || 
                        session.customer_email || 
                        session.metadata?.customerEmail ||
                        session.customer?.email;
    
    if (!customerEmail || !customerEmail.includes('@')) {
      throw new Error('Valid customer email is required');
    }
    
    console.log('📧 Using customer email:', customerEmail);
    
    // STEP 1: Check server limits first
    await checkServerLimits();
    
    // STEP 2: Create or find user
    const userResult = await CreateUser(customerEmail);
    console.log('👤 User result:', {
      id: userResult.userId,
      username: userResult.username,
      existing: userResult.existing
    });
    
    // STEP 3: Get available allocation
    const allocation = await getAvailableAllocation(nodeId);
    
    // STEP 4: Prepare server configuration
    const serverName = session.metadata?.serverName || `Server-${Date.now()}`;
    const totalRam = parseInt(session.metadata?.totalRam) || 4;
    const maxPlayers = parseInt(session.metadata?.maxPlayers) || 20;
    const minecraftVersion = session.metadata?.minecraftVersion || 'latest';
    
    const serverData = {
      name: serverName,
      user: userResult.userId, // This assigns ownership to the user
      egg: parseInt(process.env.PTERODACTYL_EGG_ID),
      docker_image: session.metadata?.dockerImage || 'ghcr.io/pterodactyl/yolks:java_17',
      startup: session.metadata?.startup || 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
      environment: {
        SERVER_JARFILE: 'server.jar',
        MINECRAFT_VERSION: minecraftVersion,
        EULA: 'true',
        ...session.metadata?.environment
      },
      limits: {
        memory: totalRam * 1024, // Convert GB to MB
        swap: 0,
        disk: totalRam * 2000, // 2GB per 1GB RAM
        io: 500,
        cpu: 0 // 0 = unlimited
      },
      feature_limits: {
        databases: 2,
        allocations: 1,
        backups: 5
      },
      allocation: {
        default: allocation.attributes.id
      }
    };
    
    console.log('🛠️ Creating server with config:', {
      ...serverData,
      user: `User ID: ${serverData.user}`,
      allocation: `Allocation ID: ${serverData.allocation.default}`
    });
    
    // STEP 5: Create the server
    const response = await pterodactylRequest('POST', '/servers', serverData);
    
    const serverId = response.data.attributes.id;
    const serverUuid = response.data.attributes.uuid;
    const serverAddress = `${allocation.attributes.ip}:${allocation.attributes.port}`;
    
    console.log('🎉 Server created successfully:', {
      id: serverId,
      uuid: serverUuid,
      address: serverAddress,
      owner: userResult.userId
    });
    
    // STEP 6: Generate credentials for frontend
    const credentials = {
      serverUsername: userResult.username,
      serverPassword: userResult.password || 'UseExistingPassword', // For existing users
      ftpHost: allocation.attributes.ip,
      ftpPort: '21',
      ftpUsername: userResult.username,
      ftpPassword: userResult.password || 'UseExistingPassword'
    };
    
    // STEP 7: Update Stripe session with all details
    if (session.id) {
      try {
        await stripe.checkout.sessions.update(session.id, {
          metadata: {
            ...session.metadata,
            serverId: serverId.toString(),
            serverUuid: serverUuid,
            serverAddress: serverAddress,
            pterodactylUserId: userResult.userId.toString(),
            pterodactylUsername: userResult.username,
            ownerEmail: customerEmail,
            userStatus: userResult.existing ? 'existing' : 'new',
            serverStatus: 'created',
            createdAt: new Date().toISOString(),
            panelUrl: `${PTERODACTYL_BASE.replace('/api', '')}/server/${serverUuid}`,
            ...credentials
          }
        });
        console.log('✅ Stripe session updated with server details');
      } catch (stripeError) {
        console.error('⚠️ Failed to update Stripe session:', stripeError.message);
        // Don't fail the entire process for this
      }
    }
    
    return {
      success: true,
      serverId,
      serverUuid,
      serverAddress,
      user: {
        id: userResult.userId,
        email: customerEmail,
        username: userResult.username,
        existing: userResult.existing
      },
      credentials,
      allocation: {
        ip: allocation.attributes.ip,
        port: allocation.attributes.port
      }
    };
    
  } catch (err) {
    console.error('❌ Server creation failed:', {
      message: err.message,
      stack: err.stack,
      response: err.response?.data
    });
    
    throw err;
  }
}

// Additional function to verify server ownership (for debugging)
const verifyServerOwnership = async (serverId, userId) => {
  try {
    const response = await pterodactylRequest('GET', `/servers/${serverId}`);
    const serverOwner = response.data.attributes.user;
    
    console.log(`🔍 Server ${serverId} owner verification:`, {
      expectedOwner: userId,
      actualOwner: serverOwner,
      matches: serverOwner === userId
    });
    
    return serverOwner === userId;
  } catch (error) {
    console.error('❌ Failed to verify server ownership:', error.message);
    return false;
  }
};

// Export functions
module.exports = {
  createPterodactylServer,
  checkServerLimits,
  CreateUser,
  generateRandomPassword,
  verifyServerOwnership,
  pterodactylRequest
};
