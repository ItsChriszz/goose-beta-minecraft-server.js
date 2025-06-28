// server.js - Fixed implementation with proper user creation and assignment
const app = express();

// Required imports
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Pterodactyl configuration
const PTERODACTYL_BASE = process.env.PTERODACTYL_BASE;
const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;

//defining env variables
const MaxServersPerNode = process.env.MaxServersPerNode;
const nodeId = process.env.PTERODACTYL_NODE_ID;

// FIXED: Create user function with proper error handling and validation
const CreateUser = async (email) => {
  try {
    console.log("🔍 Checking if user exists for email:", email);
    
    // Validate email format
    if (!email || !email.includes('@')) {
      throw new Error('Invalid email format');
    }
    
    // STEP 1: Check if user already exists by email
    try {
      const searchResponse = await axios.get(`${PTERODACTYL_BASE}/api/application/users`, {
        headers: {
          Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        params: {
          'filter[email]': email
        }
      });
      
      console.log("🔎 Search response:", searchResponse.data);
      
      if (searchResponse.data.data && searchResponse.data.data.length > 0) {
        const existingUser = searchResponse.data.data[0].attributes;
        console.log("✅ User already exists:", existingUser);
        return {
          success: true,
          userId: existingUser.id,
          username: existingUser.username,
          email: existingUser.email,
          existing: true
        };
      }
      
      console.log("👤 User doesn't exist, proceeding to create new user");
    } catch (searchError) {
      console.log("⚠️ Error searching for existing user:", searchError.response?.data || searchError.message);
      // Continue with creation
    }
    
    // STEP 2: Generate unique username
    const baseUsername = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const timestamp = Date.now().toString().slice(-6);
    const username = `${baseUsername}${timestamp}`;
    
    // Generate a temporary password for the user
    const tempPassword = generateRandomPassword(12);
    
    // STEP 3: Create new user with all required fields
    const userData = {
      email: email,
      username: username,
      first_name: baseUsername,
      last_name: "User",
      password: tempPassword // Required for user creation
    };
    
    console.log("📝 Creating user with data:", { ...userData, password: '[HIDDEN]' });
    
    const response = await axios.post(`${PTERODACTYL_BASE}/api/application/users`, userData, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    });
    
    console.log("✅ User created successfully:", response.data.attributes);
    return {
      success: true,
      userId: response.data.attributes.id,
      username: response.data.attributes.username,
      email: response.data.attributes.email,
      existing: false
    };
    
  } catch (error) {
    console.error("❌ Error in CreateUser:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      headers: error.response?.config?.headers
    });
    
    // FALLBACK: If creation failed due to existing user (422), try to find them
    if (error.response?.status === 422) {
      console.log("🔄 Creation failed due to conflict, searching for existing user...");
      try {
        const searchResponse = await axios.get(`${PTERODACTYL_BASE}/api/application/users`, {
          headers: {
            Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
            Accept: 'application/json'
          },
          params: {
            'filter[email]': email
          }
        });
        
        if (searchResponse.data.data && searchResponse.data.data.length > 0) {
          const existingUser = searchResponse.data.data[0].attributes;
          console.log("✅ Found existing user on fallback search:", existingUser);
          return {
            success: true,
            userId: existingUser.id,
            username: existingUser.username,
            email: existingUser.email,
            existing: true
          };
        }
      } catch (searchError) {
        console.error("❌ Fallback search failed:", searchError.message);
      }
    }
    
    throw new Error(`Failed to create user: ${error.response?.data?.errors?.[0]?.detail || error.message}`);
  }
};

// FIXED: Assign user to server as subuser with proper API endpoint
const AssignUserToServer = async (serverId, email) => {
  try {
    console.log(`🔗 Assigning user ${email} to server ${serverId} as subuser`);
    
    // First, get the server details to ensure it exists
    const serverResponse = await axios.get(`${PTERODACTYL_BASE}/api/application/servers/${serverId}`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });
    
    console.log("📦 Server exists, proceeding with user assignment");
    
    // Create subuser assignment
    const response = await axios.post(
      `${PTERODACTYL_BASE}/api/application/servers/${serverId}/users`, 
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
          "file.sftp",
          "allocation.read",
          "startup.read",
          "startup.update"
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
    console.error("❌ Error assigning user to server:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
    // Don't throw error if user is already assigned
    if (error.response?.status === 422) {
      console.log("⚠️ User may already be assigned to server, continuing...");
      return { success: true, message: "User already assigned" };
    }
    
    throw error;
  }
};

// FIXED: Main server creation function with proper user creation flow
async function createPterodactylServer(session) {
  try {
    console.log('🦆 GOOSE HOSTING - PTERODACTYL DEPLOYMENT');
    console.log('==========================================');
    
    // Get customer email with better validation
    const customerEmail = session.customer_details?.email || 
                         session.customer_email || 
                         session.metadata?.customerEmail;
    
    if (!customerEmail) {
      throw new Error('No customer email found in Stripe session');
    }
    
    console.log('📧 Customer Email:', customerEmail);

    // STEP 1: Create or find the user FIRST
    console.log('👤 Creating/finding Pterodactyl user...');
    const userResult = await CreateUser(customerEmail);
    
    if (!userResult.success) {
      throw new Error('Failed to create or find user');
    }
    
    console.log(`${userResult.existing ? '📋' : '🆕'} User ${userResult.existing ? 'found' : 'created'}:`, {
      id: userResult.userId,
      username: userResult.username,
      email: userResult.email
    });

    // Get configuration
    const config = await fetchPterodactylMeta(customerEmail);
    
    // Extract server configuration from session metadata
    const serverName = session.metadata.serverName || `GooseServer-${Date.now()}`;
    const totalRam = parseInt(session.metadata.totalRam) || 4;
    const maxPlayers = parseInt(session.metadata.maxPlayers) || 20;
    // ... other config as before

    // Get allocation
    const allocRes = await axios.get(`${PTERODACTYL_BASE}/api/application/nodes/${config.nodeId}/allocations`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const allocation = allocRes.data.data.find(a => !a.attributes.assigned);
    if (!allocation) throw new Error('No free allocation found');

    const serverPort = allocation.attributes.port;
    const serverAddress = `mc.goosehosting.com:${serverPort}`;

    // STEP 2: Create the server with the user as owner
    const serverData = {
      name: serverName,
      user: userResult.userId, // Set the created user as owner
      egg: config.eggId,
      docker_image: config.dockerImage,
      startup: config.startup,
      environment: {
        SERVER_JARFILE: 'server.jar',
        BUILD_NUMBER: 'latest',
        VERSION: session.metadata.minecraftVersion || 'latest',
        SERVER_MEMORY: totalRam * 1024,
        MAX_PLAYERS: maxPlayers,
        // ... other environment variables
      },
      limits: {
        memory: totalRam * 1024,
        swap: 0,
        disk: Math.max(5000, totalRam * 1000),
        io: 500,
        cpu: 0
      },
      feature_limits: {
        databases: 2,
        allocations: 1,
        backups: 10
      },
      allocation: {
        default: allocation.attributes.id
      }
    };

    console.log('🚀 Creating server with user as owner...');
    
    const response = await axios.post(`${PTERODACTYL_BASE}/api/application/servers`, serverData, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    });

    const serverId = response.data.attributes?.id;
    const serverUuid = response.data.attributes?.uuid;

    if (!serverId || !serverUuid) {
      throw new Error('Server creation failed - no ID or UUID returned');
    }

    console.log('✅ Server created successfully!');
    console.log('📦 Server Details:', {
      serverId,
      serverUuid,
      serverName,
      serverAddress,
      ownerId: userResult.userId,
      ownerUsername: userResult.username,
      ownerEmail: customerEmail
    });

    // STEP 3: Wait a moment for server to be fully initialized
    await new Promise(resolve => setTimeout(resolve, 2000));

    // STEP 4: Optionally assign additional permissions (if needed)
    // Since the user is already the owner, they have full access
    // But if you want to explicitly add subuser permissions, uncomment:
    /*
    try {
      await AssignUserToServer(serverId, customerEmail);
      console.log('✅ Additional permissions assigned');
    } catch (assignError) {
      console.log('⚠️ Additional permission assignment failed (user is already owner):', assignError.message);
    }
    */

    // Generate credentials for the server
    const credentials = generateServerCredentials(customerEmail, serverName);

    // Update Stripe session with server details
    await stripe.checkout.sessions.update(session.id, {
      metadata: {
        ...session.metadata,
        serverId: String(serverId),
        serverUuid: String(serverUuid),
        serverAddress: serverAddress,
        serverStatus: 'created',
        pterodactylUserId: String(userResult.userId),
        pterodactylUsername: userResult.username,
        ownerEmail: customerEmail,
        userStatus: userResult.existing ? 'existing' : 'new',
        createdAt: new Date().toISOString(),
        panelUrl: `https://panel.goosehosting.com/server/${serverUuid}`
      }
    });

    console.log('📝 Updated Stripe session with server details');
    console.log('==========================================');

    return {
      success: true,
      serverId,
      serverUuid,
      serverName,
      serverAddress,
      credentials,
      user: {
        id: userResult.userId,
        username: userResult.username,
        email: customerEmail,
        existing: userResult.existing
      },
      message: 'Server created successfully with user as owner'
    };

  } catch (err) {
    console.error('❌ Server creation failed:', {
      error: err.message,
      response: err.response?.data,
      status: err.response?.status
    });
    
    throw err;
  }
}

// Generate secure password utility
function generateRandomPassword(length = 16) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return password;
}

// Generate server credentials
function generateServerCredentials(customerEmail, serverName) {
  const serverPassword = generateRandomPassword(16);
  const username = customerEmail.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const finalUsername = username + '_' + Date.now().toString().slice(-4);
  
  return {
    username: finalUsername,
    password: serverPassword,
    serverName: serverName
  };
}

// Fetch Pterodactyl metadata
async function fetchPterodactylMeta(customerEmail) {
  return {
    userId: process.env.PTERODACTYL_USER_ID,
    nodeId: process.env.PTERODACTYL_NODE_ID,
    eggId: process.env.PTERODACTYL_EGG_ID,
    dockerImage: 'ghcr.io/pterodactyl/yolks:java_17',
    startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}'
  };
}

// Server limit checking middleware
const checkServerLimits = async (req, res, next) => {
  try {
    const nodeId = process.env.PTERODACTYL_NODE_ID;
    const response = await axios.get(`${PTERODACTYL_BASE}/api/application/nodes/${nodeId}/servers`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });
    
    const currentServers = response.data.data.length;
    if (currentServers >= MaxServersPerNode) {
      return res.status(403).json({ error: 'Server limit reached for this node.' });
    }
    
    next();
  } catch (err) {
    console.error('❌ Server check failed:', err.message);
    return res.status(500).json({ error: 'Internal error during server validation.' });
  }
};

module.exports = {
  createPterodactylServer,
  checkServerLimits,
  generateServerCredentials,
  generateRandomPassword,
  CreateUser,
  AssignUserToServer
};
