// server.js - Fixed implementation with proper user creation and assignment
const app = express();

// Required imports
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Pterodactyl configuration
const PTERODACTYL_BASE = process.env.PTERODACTYL_BASE;
const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;

//defining env variables
const MaxServersPerNode = process.env.MaxServersPerNode;  //maximum servers allowed
const nodeId = process.env.PTERODACTYL_NODE_ID;  //node ID for server

// Create user function - fixed version with email existence check
// Email parameter comes from Stripe session in createPterodactylServer function
const CreateUser = async (email) => {
  try {
    console.log("Checking if user exists for email from Stripe:", email);
    
    // STEP 1: First check if user already exists by email
    try {
      const searchResponse = await axios.get(`${PTERODACTYL_BASE}/users?filter[email]=${encodeURIComponent(email)}`, {
        headers: {
          Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
          Accept: 'application/json'
        }
      });
      
      if (searchResponse.data.data.length > 0) {
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
      
      console.log("User doesn't exist, proceeding to create new user");
    } catch (searchError) {
      console.log("⚠️ Error searching for existing user, proceeding with creation:", searchError.message);
    }
    
    // STEP 2: If user doesn't exist, create new user
    console.log("Creating new user for email:", email);
    
    // Generate username from email (remove @ and everything after, clean special chars)
    const username = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    
    const userData = {
      email: email,
      username: username,
      first_name: username, // Using username as first name
      last_name: "User"
    };
    
    console.log("User data:", userData);
    
    const response = await axios.post(`${PTERODACTYL_BASE}/users`, userData, {
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
    console.log("❌ Error in CreateUser:", error.response?.data || error.message);
    
    // Fallback: If creation failed due to existing user (422), try to find them one more time
    if (error.response?.status === 422) {
      console.log("Creation failed due to conflict, making final attempt to find existing user...");
      try {
        const searchResponse = await axios.get(`${PTERODACTYL_BASE}/users?filter[email]=${encodeURIComponent(email)}`, {
          headers: {
            Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
            Accept: 'application/json'
          }
        });
        
        if (searchResponse.data.data.length > 0) {
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
        console.log("❌ Final search also failed:", searchError.message);
      }
    }
    
    throw error;
  }
};

// Assign user to server as subuser
const AssignUserToServer = async (serverId, userId, email) => {
  try {
    console.log(`Assigning user ${userId} (${email}) to server ${serverId}`);
    
    const response = await axios.post(`${PTERODACTYL_BASE}/servers/${serverId}/users`, 
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
    console.log("❌ Error assigning user to server:", error.response?.data || error.message);
    throw error;
  }
};

// Updated CreatePanelAccount function (keeping for compatibility)
const CreatePanelAccount = async (req, res, next) => {
  try {
    const { email, serverId } = req.body;
    
    if (!email || !serverId) {
      return res.status(400).json({ 
        success: false, 
        error: "Email and serverId are required" 
      });
    }
    
    const result = await AssignUserToServer(serverId, null, email);
    res.json(result);
    
  } catch (error) {
    console.log("Error in CreatePanelAccount:", error.response?.data || error.message);
    res.status(500).json({ success: false, error: "Failed to create panel account" });
  }
};

// Server limit checking middleware
const checkServerLimits = async (req, res, next) => {
  try {
    // Example check: max 5 servers per node
    const nodeId = process.env.PTERODACTYL_NODE_ID;
    const response = await axios.get(`${PTERODACTYL_BASE}/nodes/${nodeId}/servers`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });
    
    const currentServers = response.data.data.length;
    if (currentServers >= MaxServersPerNode) {
      return res.status(403).json({ error: 'Server limit reached for this node.' });
    }
    
    next(); // continue to the actual route handler
  } catch (err) {
    console.error('❌ Server check failed:', err.message);
    return res.status(500).json({ error: 'Internal error during server validation.' });
  }
};

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
  // Generate a secure password for the server
  const serverPassword = generateRandomPassword(16);
  
  // Create username from email (clean format)
  const username = customerEmail.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const finalUsername = username + '_' + Date.now().toString().slice(-4);
  
  return {
    username: finalUsername,
    password: serverPassword,
    serverName: serverName
  };
}

// Fetch Pterodactyl metadata (you'll need to implement this function)
async function fetchPterodactylMeta(customerEmail) {
  // This function should return the configuration needed for server creation
  // Example implementation:
  return {
    userId: process.env.PTERODACTYL_USER_ID, // The user ID in Pterodactyl
    nodeId: process.env.PTERODACTYL_NODE_ID, // The node to create server on
    eggId: process.env.PTERODACTYL_EGG_ID, // The egg ID for Minecraft servers
    dockerImage: 'ghcr.io/pterodactyl/yolks:java_17', // Docker image for Java
    startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}'
  };
}

// Main server creation function - UPDATED with user creation and assignment
async function createPterodactylServer(session) {
  try {
    console.log('🦆 GOOSE HOSTING - PTERODACTYL DEPLOYMENT');
    console.log('==========================================');
    console.log('📋 Session Metadata:', session.metadata);

    // Get customer email from Stripe session with multiple fallbacks
    const customerEmail = session.customer_details?.email || 
                         session.customer_email || 
                         session.metadata?.customerEmail ||
                         session.customer?.email ||
                         'admin@goosehosting.com';
    console.log('📧 Customer Email from Stripe:', customerEmail);
    console.log('📋 Available Stripe session fields:', {
      customer_details_email: session.customer_details?.email,
      customer_email: session.customer_email,
      metadata_customerEmail: session.metadata?.customerEmail,
      customer_object_email: session.customer?.email
    });

    // STEP 1: Create or find the user first using email from Stripe
    console.log('👤 Creating/finding Pterodactyl user with Stripe email...');
    const userResult = await CreateUser(customerEmail); // Pass Stripe email here
    console.log('User result:', userResult);
    
    // Log whether user was existing or newly created
    if (userResult.existing) {
      console.log('📋 Using existing user - will assign server to existing account');
    } else {
      console.log('🆕 Created new user - will assign server to new account');
    }

    const config = await fetchPterodactylMeta(customerEmail);
    
    // Extract individual metadata fields (all are strings from Stripe)
    const serverName = session.metadata.serverName || `GooseServer-${Date.now()}`;
    const serverType = session.metadata.serverType || 'paper';
    const minecraftVersion = session.metadata.minecraftVersion || 'latest';
    const planId = session.metadata.planId || 'pro';
    const maxPlayers = parseInt(session.metadata.maxPlayers) || 20;
    const totalRam = parseInt(session.metadata.totalRam) || 4;
    const viewDistance = parseInt(session.metadata.viewDistance) || 10;
    const enableWhitelist = session.metadata.enableWhitelist === 'true';
    const enablePvp = session.metadata.enablePvp === 'true';
    const selectedPlugins = session.metadata.selectedPlugins ? session.metadata.selectedPlugins.split(',') : [];

    console.log('🎮 Server Configuration:');
    console.log('  • Server Name:', serverName);
    console.log('  • Server Type:', serverType);
    console.log('  • Minecraft Version:', minecraftVersion);
    console.log('  • Plan:', planId);
    console.log('  • Max Players:', maxPlayers);
    console.log('  • RAM:', totalRam + 'GB');
    console.log('  • View Distance:', viewDistance);
    console.log('  • Whitelist:', enableWhitelist);
    console.log('  • PvP:', enablePvp);
    console.log('  • Plugins:', selectedPlugins.length > 0 ? selectedPlugins.join(', ') : 'None');

    // Generate server credentials
    const credentials = generateServerCredentials(customerEmail, serverName);
    console.log('🔐 Generated Credentials:');
    console.log('  • Username:', credentials.username);
    console.log('  • Password:', credentials.password);

    // Get the allocation info BEFORE creating the server
    const allocRes = await axios.get(`${PTERODACTYL_BASE}/nodes/${config.nodeId}/allocations`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const allocation = allocRes.data.data.find(a => !a.attributes.assigned);
    if (!allocation) throw new Error('No free allocation found.');

    const serverPort = allocation.attributes.port;
    const serverAddress = `mc.goosehosting.com:${serverPort}`;

    console.log('🌐 Server Address:', serverAddress);

    // Determine server jar based on server type
    let serverJar = 'server.jar';
    let buildNumber = 'latest';
    
    switch (serverType) {
      case 'paper':
        serverJar = 'server.jar';
        buildNumber = 'latest';
        break;
      case 'spigot':
        serverJar = 'spigot.jar';
        buildNumber = 'latest';
        break;
      case 'fabric':
        serverJar = 'fabric-server-launch.jar';
        buildNumber = 'latest';
        break;
      case 'forge':
        serverJar = 'forge-server.jar';
        buildNumber = 'latest';
        break;
      case 'vanilla':
        serverJar = 'server.jar';
        buildNumber = 'latest';
        break;
      default:
        serverJar = 'server.jar';
        buildNumber = 'latest';
    }

    // STEP 2: Create the server with the created user as owner
    const serverData = {
      name: serverName,
      user: userResult.userId, // Use the created/found user ID
      egg: config.eggId,
      docker_image: config.dockerImage,
      startup: config.startup,
      environment: {
        SERVER_JARFILE: serverJar,
        BUILD_NUMBER: buildNumber,
        VERSION: minecraftVersion,
        VANILLA_VERSION: minecraftVersion,
        SERVER_MEMORY: totalRam * 1024, // Convert GB to MB
        MAX_PLAYERS: maxPlayers,
        VIEW_DISTANCE: viewDistance,
        WHITE_LIST: enableWhitelist,
        PVP: enablePvp,
        DIFFICULTY: 'normal',
        GAMEMODE: 'survival',
        LEVEL_TYPE: 'default',
        SPAWN_PROTECTION: '16',
        ALLOW_NETHER: 'true',
        ENABLE_COMMAND_BLOCK: 'false',
        SPAWN_ANIMALS: 'true',
        SPAWN_MONSTERS: 'true',
        GENERATE_STRUCTURES: 'true'
      },
      limits: {
        memory: totalRam * 1024, // Convert GB to MB
        swap: 0,
        disk: Math.max(5000, totalRam * 1000), // 5GB minimum, or 1GB per GB of RAM
        io: 500,
        cpu: 0 // 0 = unlimited
      },
      feature_limits: {
        databases: planId === 'starter' ? 1 : planId === 'pro' ? 2 : 5,
        allocations: 1,
        backups: planId === 'starter' ? 3 : planId === 'pro' ? 10 : 25
      },
      allocation: {
        default: allocation.attributes.id
      }
    };

    console.log('🚀 Creating Pterodactyl server with data:');
    console.log(JSON.stringify(serverData, null, 2));

    const response = await axios.post(`${PTERODACTYL_BASE}/servers`, serverData, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'Application/vnd.pterodactyl.v1+json'
      }
    });

    const serverId = response.data.attributes?.id;
    const serverUuid = response.data.attributes?.uuid;

    console.log('✅ Server created successfully!');
    console.log('📦 Server Details:');
    console.log('  • Server ID:', serverId);
    console.log('  • Server UUID:', serverUuid);
    console.log('  • Server Address:', serverAddress);
    console.log('  • Name:', serverName);
    console.log('  • Owner User ID:', userResult.userId);
    console.log('  • Owner Username:', userResult.username);
    console.log('  • Owner Email:', customerEmail);
    console.log('  • User Status:', userResult.existing ? 'Existing User' : 'Newly Created');
    console.log('  • Allocation ID:', allocation.attributes.id);
    console.log('  • Egg ID:', config.eggId);
    console.log('  • Docker Image:', config.dockerImage);

    // STEP 3: The user is automatically the owner since we set user: userResult.userId
    // No additional assignment needed, but log the ownership
    console.log('🎯 Server automatically assigned to user:', {
      userId: userResult.userId,
      username: userResult.username,
      email: customerEmail,
      relationship: 'Owner'
    });

    console.log('==========================================');

    // Update the Stripe session with ALL server details including credentials
    await stripe.checkout.sessions.update(session.id, {
      metadata: {
        ...session.metadata,
        serverId: String(serverId),
        serverUuid: String(serverUuid),
        serverAddress: serverAddress,
        serverStatus: 'created',
        // Add server credentials and connection info
        serverUsername: credentials.username,
        serverPassword: credentials.password,
        panelUrl: `https://panel.goosehosting.com/server/${serverUuid}`,
        ftpHost: 'ftp.goosehosting.com',
        ftpPort: '21',
        ftpUsername: credentials.username,
        ftpPassword: credentials.password,
        // Additional server info
        serverPort: String(serverPort),
        serverHost: 'mc.goosehosting.com',
        pterodactylUserId: String(userResult.userId),
        pterodactylUsername: userResult.username,
        ownerEmail: customerEmail,
        userStatus: userResult.existing ? 'existing' : 'new',
        createdAt: new Date().toISOString()
      }
    });

    console.log('📝 Updated Stripe session with complete server details including user info');

    // If plugins are selected and it's a supported server type, we could install them here
    if (selectedPlugins.length > 0 && (serverType === 'paper' || serverType === 'spigot')) {
      console.log('📦 Plugins to install:', selectedPlugins);
      // Plugin installation would happen here via Pterodactyl file API
      // This would require additional API calls to upload plugin files
    }

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
        email: customerEmail
      },
      message: 'Server created successfully with user assignment'
    };

  } catch (err) {
    console.error('❌ Server creation failed:', {
      error: err.message,
      response: err.response?.data,
      status: err.response?.status,
      headers: err.response?.headers
    });
    
    throw err;
  }
}

// Example route using the middleware
// app.post('/api/create-server', checkServerLimits, async (req, res) => {
//   try {
//     const result = await createPterodactylServer(req.body.session);
//     res.json(result);
//   } catch (error) {
//     res.status(500).json({ error: error.message });
//   }
// });

module.exports = {
  createPterodactylServer,
  checkServerLimits,
  generateServerCredentials,
  generateRandomPassword,
  CreateUser,
  AssignUserToServer,
  CreatePanelAccount
};
