// server.js - Fixed implementation with proper email extraction and validation

const app = express();

// Required imports
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Pterodactyl configuration
const PTERODACTYL_BASE = process.env.PTERODACTYL_BASE;
const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;
const MaxServersPerNode = process.env.MaxServersPerNode;
const nodeId = process.env.PTERODACTYL_NODE_ID;

// Helper function to extract customer email from Stripe session
function extractCustomerEmail(session) {
  console.log('🔍 Extracting customer email from Stripe session...');
  console.log('Available session data:', {
    customer_details: session.customer_details,
    customer_email: session.customer_email,
    customer: session.customer,
    metadata: session.metadata
  });

  // Try different ways to get the email
  const possibleEmails = [
    session.customer_details?.email,
    session.customer_email,
    session.metadata?.customerEmail,
    session.metadata?.customer_email,
    session.customer?.email
  ].filter(email => email && email.includes('@')); // Filter out undefined/invalid emails

  console.log('Found possible emails:', possibleEmails);

  if (possibleEmails.length === 0) {
    console.error('❌ No valid email found in Stripe session');
    throw new Error('Customer email not found in Stripe session. Please ensure customer email is collected during checkout.');
  }

  const customerEmail = possibleEmails[0]; // Use the first valid email found
  console.log('✅ Using customer email:', customerEmail);
  return customerEmail;
}

// Create user function - with better error handling
const CreateUser = async (email) => {
  try {
    // Validate email first
    if (!email || !email.includes('@')) {
      throw new Error('Invalid email provided to CreateUser function');
    }

    console.log("Checking if user exists for email:", email);
    
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
        console.log("✅ User already exists:", existingUser.email);
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
    let username = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    
    // Ensure username is at least 3 characters and not longer than 16
    if (username.length < 3) {
      username = username + Math.random().toString(36).substring(2, 5);
    }
    if (username.length > 16) {
      username = username.substring(0, 16);
    }
    
    const userData = {
      email: email,
      username: username,
      first_name: username,
      last_name: "User"
    };
    
    console.log("Creating user with data:", userData);
    
    const response = await axios.post(`${PTERODACTYL_BASE}/users`, userData, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    });
    
    console.log("✅ User created successfully:", response.data.attributes.email);
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
          console.log("✅ Found existing user on fallback search:", existingUser.email);
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

// Main server creation function - FIXED with proper email validation
async function createPterodactylServer(session) {
  try {
    console.log('🦆 GOOSE HOSTING - PTERODACTYL DEPLOYMENT');
    console.log('==========================================');

    // STEP 0: Extract and validate customer email FIRST
    let customerEmail;
    try {
      customerEmail = extractCustomerEmail(session);
    } catch (emailError) {
      console.error('❌ Failed to extract customer email:', emailError.message);
      throw new Error(`Email extraction failed: ${emailError.message}`);
    }

    console.log('📧 Validated Customer Email:', customerEmail);

    // STEP 1: Create or find the user with the validated email
    console.log('👤 Creating/finding Pterodactyl user...');
    let userResult;
    try {
      userResult = await CreateUser(customerEmail);
      console.log('✅ User operation successful:', {
        userId: userResult.userId,
        username: userResult.username,
        email: userResult.email,
        existing: userResult.existing
      });
    } catch (userError) {
      console.error('❌ User creation/retrieval failed:', userError.message);
      throw new Error(`User operation failed: ${userError.message}`);
    }

    // Continue with the rest of your server creation logic...
    const config = await fetchPterodactylMeta(customerEmail);
    
    // Extract individual metadata fields (all are strings from Stripe)
    const serverName = session.metadata?.serverName || `GooseServer-${Date.now()}`;
    const serverType = session.metadata?.serverType || 'paper';
    const minecraftVersion = session.metadata?.minecraftVersion || 'latest';
    const planId = session.metadata?.planId || 'pro';
    const maxPlayers = parseInt(session.metadata?.maxPlayers) || 20;
    const totalRam = parseInt(session.metadata?.totalRam) || 4;
    const viewDistance = parseInt(session.metadata?.viewDistance) || 10;
    const enableWhitelist = session.metadata?.enableWhitelist === 'true';
    const enablePvp = session.metadata?.enablePvp === 'true';
    const selectedPlugins = session.metadata?.selectedPlugins ? session.metadata.selectedPlugins.split(',') : [];

    console.log('🎮 Server Configuration:');
    console.log('  • Server Name:', serverName);
    console.log('  • Server Type:', serverType);
    console.log('  • Owner Email:', customerEmail);
    console.log('  • Owner User ID:', userResult.userId);
    console.log('  • Owner Username:', userResult.username);

    // Generate server credentials
    const credentials = generateServerCredentials(customerEmail, serverName);

    // Get allocation
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

    // Determine server jar based on server type
    let serverJar = 'server.jar';
    let buildNumber = 'latest';
    
    switch (serverType) {
      case 'paper':
        serverJar = 'server.jar';
        break;
      case 'spigot':
        serverJar = 'spigot.jar';
        break;
      case 'fabric':
        serverJar = 'fabric-server-launch.jar';
        break;
      case 'forge':
        serverJar = 'forge-server.jar';
        break;
      case 'vanilla':
        serverJar = 'server.jar';
        break;
      default:
        serverJar = 'server.jar';
    }

    // STEP 2: Create the server with the validated user as owner
    const serverData = {
      name: serverName,
      user: userResult.userId, // Use the validated user ID
      egg: config.eggId,
      docker_image: config.dockerImage,
      startup: config.startup,
      environment: {
        SERVER_JARFILE: serverJar,
        BUILD_NUMBER: buildNumber,
        VERSION: minecraftVersion,
        VANILLA_VERSION: minecraftVersion,
        SERVER_MEMORY: totalRam * 1024,
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
        memory: totalRam * 1024,
        swap: 0,
        disk: Math.max(5000, totalRam * 1000),
        io: 500,
        cpu: 0
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

    console.log('🚀 Creating Pterodactyl server...');

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
    console.log('  • Owner Email:', customerEmail);
    console.log('  • Owner User ID:', userResult.userId);

    // Update Stripe session with server details
    await stripe.checkout.sessions.update(session.id, {
      metadata: {
        ...session.metadata,
        serverId: String(serverId),
        serverUuid: String(serverUuid),
        serverAddress: serverAddress,
        serverStatus: 'created',
        serverUsername: credentials.username,
        serverPassword: credentials.password,
        panelUrl: `https://panel.goosehosting.com/server/${serverUuid}`,
        ftpHost: 'ftp.goosehosting.com',
        ftpPort: '21',
        ftpUsername: credentials.username,
        ftpPassword: credentials.password,
        serverPort: String(serverPort),
        serverHost: 'mc.goosehosting.com',
        pterodactylUserId: String(userResult.userId),
        pterodactylUsername: userResult.username,
        ownerEmail: customerEmail,
        userStatus: userResult.existing ? 'existing' : 'new',
        createdAt: new Date().toISOString()
      }
    });

    console.log('✅ Updated Stripe session with complete server details');
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
        email: customerEmail
      },
      message: 'Server created successfully with user assignment'
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

// Assign user to server as subuser (keeping your existing function)
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

// Server limit checking middleware
const checkServerLimits = async (req, res, next) => {
  try {
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
    
    next();
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

// Updated CreatePanelAccount function
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

module.exports = {
  createPterodactylServer,
  checkServerLimits,
  generateServerCredentials,
  generateRandomPassword,
  CreateUser,
  AssignUserToServer,
  CreatePanelAccount,
  extractCustomerEmail // Export the new helper function
};
