// server.js - Fixed and optimized implementation
const app = express();

// Required imports
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Validate environment variables
const validateEnvVars = () => {
  const requiredVars = [
    'STRIPE_SECRET_KEY',
    'PTERODACTYL_BASE',
    'PTERODACTYL_API_KEY',
    'MaxServersPerNode',
    'PTERODACTYL_NODE_ID',
    'PTERODACTYL_EGG_ID',
    'PTERODACTYL_USER_ID'
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

// Improved CreateUser function with better error handling
const CreateUser = async (email) => {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('Invalid email address provided');
  }

  try {
    console.log(`🔍 Searching for existing user with email: ${email}`);
    
    // STEP 1: Search for existing user
    const searchResponse = await axios.get(
      `${PTERODACTYL_BASE}/users?filter[email]=${encodeURIComponent(email)}`, 
      {
        headers: {
          Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
          Accept: 'application/json'
        }
      }
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
    
    // Generate clean username
    const username = generateUsernameFromEmail(email);
    
    const userData = {
      email: email,
      username: username,
      first_name: username,
      last_name: "User",
      password: generateRandomPassword(16),
      root_admin: false,
      language: "en"
    };
    
    const response = await axios.post(
      `${PTERODACTYL_BASE}/users`, 
      userData, 
      {
        headers: {
          Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log("✅ User created successfully:", response.data.attributes.username);
    return {
      success: true,
      userId: response.data.attributes.id,
      username: response.data.attributes.username,
      email: response.data.attributes.email,
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
      if (errors.some(e => e.detail.includes('already exists'))) {
        // Final attempt to find user if creation failed due to race condition
        try {
          const finalSearch = await axios.get(
            `${PTERODACTYL_BASE}/users?filter[email]=${encodeURIComponent(email)}`,
            { headers: { Authorization: `Bearer ${PTERODACTYL_API_KEY}` } }
          );
          
          if (finalSearch.data.data.length > 0) {
            const user = finalSearch.data.data[0].attributes;
            return {
              success: true,
              userId: user.id,
              username: user.username,
              email: user.email,
              existing: true
            };
          }
        } catch (finalError) {
          console.error("Final search failed:", finalError.message);
        }
      }
    }
    
    throw new Error(`Failed to create/find user: ${error.message}`);
  }
};

// Helper function to generate username from email
function generateUsernameFromEmail(email) {
  return email.split('@')[0]
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .slice(0, 16) + Math.floor(Math.random() * 1000);
}

// Improved AssignUserToServer with validation
const AssignUserToServer = async (serverId, userId, email) => {
  if (!serverId || !email) {
    throw new Error('serverId and email are required');
  }

  try {
    console.log(`🔗 Assigning user to server ${serverId}`);
    
    const response = await axios.post(
      `${PTERODACTYL_BASE}/servers/${serverId}/users`, 
      {
        email: email,
        permissions: [
          "control.console",
          "control.start",
          "control.stop",
          "control.restart",
          "file.create",
          "file.read",
          "file.update",
          "file.delete",
          "file.archive",
          "file.sftp"
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log("✅ User assigned to server successfully");
    return { success: true, data: response.data };
    
  } catch (error) {
    console.error("❌ Assignment error:", {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
    
    // Handle case where user is already assigned
    if (error.response?.status === 422 && 
        error.response?.data?.errors?.[0]?.detail?.includes('already assigned')) {
      return { success: true, message: 'User already assigned to server' };
    }
    
    throw new Error(`Failed to assign user to server: ${error.message}`);
  }
};

// Fixed server limit checking
const checkServerLimits = async (req, res, next) => {
  try {
    console.log(`🔄 Checking server limits on node ${nodeId}`);
    
    const response = await axios.get(
      `${PTERODACTYL_BASE}/nodes/${nodeId}/servers`, 
      {
        headers: {
          Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
          Accept: 'application/json'
        }
      }
    );
    
    const currentServers = response.data.data.length;
    console.log(`📊 Current servers: ${currentServers}/${MaxServersPerNode}`);
    
    if (currentServers >= MaxServersPerNode) {
      console.error(`🚨 Server limit reached (${currentServers}/${MaxServersPerNode})`);
      return res.status(429).json({ 
        error: 'Server limit reached',
        current: currentServers,
        max: MaxServersPerNode
      });
    }
    
    next();
  } catch (err) {
    console.error('❌ Server limit check failed:', err.message);
    return res.status(500).json({ 
      error: 'Internal server error during limit validation',
      details: err.message
    });
  }
};

// Improved server creation with proper user assignment
async function createPterodactylServer(session) {
  try {
    console.log('🚀 Starting server creation process');
    
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
    
    // STEP 1: Create or find user
    const userResult = await CreateUser(customerEmail);
    console.log('👤 User result:', {
      id: userResult.userId,
      username: userResult.username,
      existing: userResult.existing
    });
    
    // STEP 2: Check server limits
    await checkServerLimits({}, { json: () => {}, status: () => ({}) }, () => {});
    
    // STEP 3: Create server configuration
    const config = {
      userId: userResult.userId, // Use the created/found user
      nodeId: nodeId,
      eggId: process.env.PTERODACTYL_EGG_ID,
      dockerImage: 'ghcr.io/pterodactyl/yolks:java_17',
      startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}'
    };
    
    // Extract server settings from session metadata
    const serverName = session.metadata?.serverName || `Server-${Date.now()}`;
    const totalRam = parseInt(session.metadata?.totalRam) || 4;
    
    // Get available allocation
    const allocRes = await axios.get(
      `${PTERODACTYL_BASE}/nodes/${nodeId}/allocations`, 
      {
        headers: {
          Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
          Accept: 'application/json'
        }
      }
    );
    
    const allocation = allocRes.data.data.find(a => !a.attributes.assigned);
    if (!allocation) throw new Error('No available server ports');
    
    // STEP 4: Create server
    const serverData = {
      name: serverName,
      user: userResult.userId, // This makes the user the owner
      egg: config.eggId,
      docker_image: config.dockerImage,
      startup: config.startup,
      environment: {
        SERVER_JARFILE: 'server.jar',
        SERVER_MEMORY: totalRam * 1024,
        MAX_PLAYERS: 20,
        EULA: 'true'
      },
      limits: {
        memory: totalRam * 1024,
        swap: 0,
        disk: totalRam * 1000,
        io: 500,
        cpu: 0
      },
      feature_limits: {
        databases: 1,
        allocations: 1,
        backups: 3
      },
      allocation: {
        default: allocation.attributes.id
      }
    };
    
    console.log('🛠️ Creating server with config:', JSON.stringify(serverData, null, 2));
    
    const response = await axios.post(
      `${PTERODACTYL_BASE}/servers`, 
      serverData, 
      {
        headers: {
          Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'Application/vnd.pterodactyl.v1+json'
        }
      }
    );
    
    const serverId = response.data.attributes.id;
    const serverUuid = response.data.attributes.uuid;
    const serverAddress = `mc.example.com:${allocation.attributes.port}`;
    
    console.log('🎉 Server created successfully:', {
      id: serverId,
      uuid: serverUuid,
      address: serverAddress,
      owner: userResult.userId
    });
    
    // STEP 5: Update Stripe session with server details
    if (session.id) {
      await stripe.checkout.sessions.update(session.id, {
        metadata: {
          ...session.metadata,
          serverId: serverId,
          serverUuid: serverUuid,
          serverAddress: serverAddress,
          pterodactylUserId: userResult.userId,
          ownerEmail: customerEmail,
          createdAt: new Date().toISOString()
        }
      });
    }
    
    return {
      success: true,
      serverId,
      serverUuid,
      serverAddress,
      user: {
        id: userResult.userId,
        email: customerEmail,
        username: userResult.username
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

// Generate secure password
function generateRandomPassword(length = 16) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  const crypto = require('crypto');
  const randomBytes = crypto.randomBytes(length);
  let password = '';
  
  for (let i = 0; i < length; i++) {
    password += charset[randomBytes[i] % charset.length];
  }
  
  return password;
}

module.exports = {
  createPterodactylServer,
  checkServerLimits,
  CreateUser,
  AssignUserToServer,
  generateRandomPassword
};
