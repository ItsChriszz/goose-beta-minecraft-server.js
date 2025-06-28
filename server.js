// Fixed server limit checking - Add this to your server.js

// Server limit checking middleware - FIXED
const checkServerLimits = async (req, res, next) => {
  try {
    console.log('🔍 Checking server limits...');
    
    const nodeId = process.env.PTERODACTYL_NODE_ID;
    const maxServers = parseInt(process.env.MaxServersPerNode) || 50; // Convert to number with fallback
    
    console.log(`Node ID: ${nodeId}, Max Servers: ${maxServers}`);
    
    // Get current server count on this node
    const response = await axios.get(`${PTERODACTYL_BASE}/nodes/${nodeId}`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });
    
    // Check if the node data includes server count
    let currentServers = 0;
    
    // Try to get server count from node stats
    if (response.data.attributes && response.data.attributes.allocated_resources) {
      // Some panels provide server count in allocated_resources
      currentServers = response.data.attributes.allocated_resources.servers || 0;
    } else {
      // Fallback: Query all servers and count those on this node
      console.log('📊 Fetching all servers to count node usage...');
      const serversResponse = await axios.get(`${PTERODACTYL_BASE}/servers`, {
        headers: {
          Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
          Accept: 'application/json'
        }
      });
      
      // Count servers on this specific node
      currentServers = serversResponse.data.data.filter(server => 
        server.attributes.node === parseInt(nodeId)
      ).length;
    }
    
    console.log(`Current servers on node ${nodeId}: ${currentServers}/${maxServers}`);
    
    if (currentServers >= maxServers) {
      console.log('❌ Server limit reached!');
      return res.status(403).json({ 
        error: 'Server limit reached for this node.',
        currentServers,
        maxServers,
        nodeId
      });
    }
    
    console.log('✅ Server limit check passed');
    req.serverLimitInfo = { currentServers, maxServers, nodeId };
    next();
    
  } catch (err) {
    console.error('❌ Server limit check failed:', err.response?.data || err.message);
    return res.status(500).json({ 
      error: 'Internal error during server validation.',
      details: err.message
    });
  }
};

// UPDATED: Main server creation function with limit checking
async function createPterodactylServer(session) {
  try {
    console.log('🦆 GOOSE HOSTING - PTERODACTYL DEPLOYMENT');
    console.log('==========================================');

    // STEP 0: CHECK SERVER LIMITS FIRST
    console.log('🔍 Checking server limits before creation...');
    const nodeId = process.env.PTERODACTYL_NODE_ID;
    const maxServers = parseInt(process.env.MaxServersPerNode) || 50;
    
    try {
      const response = await axios.get(`${PTERODACTYL_BASE}/nodes/${nodeId}`, {
        headers: {
          Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
          Accept: 'application/json'
        }
      });
      
      let currentServers = 0;
      
      // Try to get server count from node stats
      if (response.data.attributes && response.data.attributes.allocated_resources) {
        currentServers = response.data.attributes.allocated_resources.servers || 0;
      } else {
        // Fallback: Query all servers and count those on this node
        const serversResponse = await axios.get(`${PTERODACTYL_BASE}/servers`, {
          headers: {
            Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
            Accept: 'application/json'
          }
        });
        
        currentServers = serversResponse.data.data.filter(server => 
          server.attributes.node === parseInt(nodeId)
        ).length;
      }
      
      console.log(`Current servers: ${currentServers}/${maxServers} on node ${nodeId}`);
      
      if (currentServers >= maxServers) {
        throw new Error(`Server limit reached: ${currentServers}/${maxServers} servers on node ${nodeId}`);
      }
      
      console.log('✅ Server limit check passed');
      
    } catch (limitError) {
      console.error('❌ Server limit check failed:', limitError.message);
      throw new Error(`Server creation blocked: ${limitError.message}`);
    }

    // STEP 1: Extract and validate customer email
    let customerEmail;
    try {
      customerEmail = extractCustomerEmail(session);
    } catch (emailError) {
      console.error('❌ Failed to extract customer email:', emailError.message);
      throw new Error(`Email extraction failed: ${emailError.message}`);
    }

    console.log('📧 Validated Customer Email:', customerEmail);

    // STEP 2: Create or find the user with the validated email
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

    // Rest of your existing server creation logic continues here...
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

    // STEP 3: Create the server with the validated user as owner
    const serverData = {
      name: serverName,
      user: userResult.userId,
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

// If you're using Express routes, make sure to apply the middleware:
// app.post('/create-server', checkServerLimits, (req, res) => {
//   // Your server creation route handler
// });

// Alternative: Function to check limits before any operation
async function checkNodeServerLimit() {
  const nodeId = process.env.PTERODACTYL_NODE_ID;
  const maxServers = parseInt(process.env.MaxServersPerNode) || 50;
  
  try {
    const response = await axios.get(`${PTERODACTYL_BASE}/servers`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });
    
    const currentServers = response.data.data.filter(server => 
      server.attributes.node === parseInt(nodeId)
    ).length;
    
    return {
      canCreate: currentServers < maxServers,
      currentServers,
      maxServers,
      nodeId
    };
  } catch (error) {
    console.error('Error checking server limits:', error.message);
    throw error;
  }
}

module.exports = {
  createPterodactylServer,
  checkServerLimits,
  checkNodeServerLimit, // Export the standalone function
  generateServerCredentials,
  generateRandomPassword,
  CreateUser,
  AssignUserToServer,
  CreatePanelAccount,
  extractCustomerEmail
};
