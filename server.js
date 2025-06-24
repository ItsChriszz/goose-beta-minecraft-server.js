// server.js - Simple Fix Without Database

require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const PORT = process.env.PORT || 3001;

// Validate required environment variables
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ STRIPE_SECRET_KEY environment variable is required');
  process.exit(1);
}

if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.error('❌ STRIPE_WEBHOOK_SECRET environment variable is required');
  process.exit(1);
}

if (!process.env.PTERODACTYL_API_KEY) {
  console.error('❌ PTERODACTYL_API_KEY environment variable is required');
  process.exit(1);
}

if (!process.env.PTERODACTYL_API_URL) {
  console.error('❌ PTERODACTYL_API_URL environment variable is required');
  process.exit(1);
}

const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;
const PTERODACTYL_BASE = process.env.PTERODACTYL_API_URL;

const app = express();

// CORS Configuration
const corsOptions = {
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use('/webhook', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());
app.use(cors(corsOptions));

// SIMPLE: In-memory storage for server details with session metadata
const serverDatabase = new Map();

// Generate random password
function generatePassword(length = 12) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return password;
}

// Generate username from email
function generateUsername(email) {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${base}${random}`;
}

// Create or get user in Pterodactyl
async function createOrGetUser(email, firstName = 'Player', lastName = 'Goose') {
  try {
    // First, check if user already exists
    const usersRes = await axios.get(`${PTERODACTYL_BASE}/users`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const existingUser = usersRes.data.data.find(u => u.attributes.email === email);
    
    if (existingUser) {
      console.log('👤 Found existing user:', email);
      return {
        userId: existingUser.attributes.id,
        username: existingUser.attributes.username,
        email: existingUser.attributes.email,
        isNewUser: false
      };
    }

    // Create new user
    const username = generateUsername(email);
    const password = generatePassword();
    
    const userData = {
      email: email,
      username: username,
      first_name: firstName,
      last_name: lastName,
      password: password
    };

    console.log('👤 Creating new user:', { email, username, firstName, lastName });

    const createUserRes = await axios.post(`${PTERODACTYL_BASE}/users`, userData, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    });

    const newUser = createUserRes.data.attributes;
    
    console.log('✅ User created successfully:', newUser.email);

    return {
      userId: newUser.id,
      username: newUser.username,
      email: newUser.email,
      password: password, // Only returned for new users
      isNewUser: true
    };

  } catch (err) {
    console.error('❌ Failed to create/get user:', err.message);
    if (err.response) {
      console.error('Response data:', err.response.data);
    }
    throw err;
  }
}

// Fetch user/egg/allocation IDs
async function fetchPterodactylMeta(userId) {
  try {
    const eggsRes = await axios.get(`${PTERODACTYL_BASE}/nests/1/eggs`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const eggData = eggsRes.data.data;
    if (!Array.isArray(eggData)) throw new Error('Unexpected response format for eggs');

    console.log('Available eggs:', eggData.map(e => e.attributes.name));

    const minecraftEgg = eggData.find(e => e.attributes.name.toLowerCase().includes('minecraft'));
    if (!minecraftEgg) throw new Error('Minecraft Java egg not found.');

    const nodesRes = await axios.get(`${PTERODACTYL_BASE}/nodes`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const nodeId = nodesRes.data.data[0].attributes.id;
    const nodeData = nodesRes.data.data[0].attributes;

    const allocRes = await axios.get(`${PTERODACTYL_BASE}/nodes/${nodeId}/allocations`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const allocation = allocRes.data.data.find(a => !a.attributes.assigned);
    if (!allocation) throw new Error('No free allocation found.');

    return {
      userId: userId,
      eggName: minecraftEgg.attributes.name,
      eggId: minecraftEgg.attributes.id,
      dockerImage: minecraftEgg.attributes.docker_image,
      startup: minecraftEgg.attributes.startup,
      allocationId: allocation.attributes.id,
      serverIp: allocation.attributes.ip,
      serverPort: allocation.attributes.port,
      nodeInfo: {
        name: nodeData.name,
        location: nodeData.location_id
      }
    };
  } catch (err) {
    console.error('❌ Failed to fetch Pterodactyl meta:', err.message);
    throw err;
  }
}

// Create server on Pterodactyl using individual metadata fields
async function createPterodactylServer(session) {
  try {
    console.log('🦆 GOOSE HOSTING - PTERODACTYL DEPLOYMENT');
    console.log('==========================================');
    console.log('📋 Session Metadata:', session.metadata);

    // Extract customer email from session
    const customerEmail = session.customer_details?.email || session.metadata.customerEmail || 'player@goosehosting.com';
    
    // Create or get user
    const userInfo = await createOrGetUser(customerEmail);
    
    // Get server configuration
    const config = await fetchPterodactylMeta(userInfo.userId);
    
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
    console.log('  • Customer Email:', customerEmail);
    console.log('  • Username:', userInfo.username);

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

    // Create the server with proper environment variables
    const serverData = {
      name: serverName,
      user: config.userId,
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
        default: config.allocationId
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
    const serverIdentifier = response.data.attributes?.identifier;

    console.log('✅ Server created successfully!');
    console.log('📦 Server Details:');
    console.log('  • Server ID:', serverId);
    console.log('  • Server UUID:', serverUuid);
    console.log('  • Server Identifier:', serverIdentifier);
    console.log('  • Name:', serverName);
    console.log('  • IP:Port:', `${config.serverIp}:${config.serverPort}`);
    console.log('  • User ID:', config.userId);
    console.log('  • Allocation ID:', config.allocationId);
    console.log('  • Egg ID:', config.eggId);
    console.log('  • Docker Image:', config.dockerImage);
    console.log('==========================================');

    // Store server details for checkout page
    const serverDetails = {
      serverId,
      serverUuid,
      serverIdentifier,
      serverName,
      serverIp: config.serverIp,
      serverPort: config.serverPort,
      serverType,
      minecraftVersion,
      planId,
      maxPlayers,
      totalRam,
      viewDistance,
      enableWhitelist,
      enablePvp,
      selectedPlugins,
      customerEmail,
      username: userInfo.username,
      password: userInfo.password, // Only present for new users
      isNewUser: userInfo.isNewUser,
      panelUrl: PTERODACTYL_BASE.replace('/api/application', ''),
      createdAt: new Date().toISOString(),
      sessionId: session.id
    };

    // Store in our database (use real database in production)
    serverDatabase.set(session.id, serverDetails);

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
      serverDetails,
      message: 'Server created successfully'
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

// Stripe Webhook Handler
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    console.log(`🔔 Received event: ${event.type}`);
  } catch (err) {
    console.error('❌ Webhook verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        console.log('💳 Payment completed, creating server...');
        await createPterodactylServer(event.data.object);
        break;
        
      case 'invoice.payment_succeeded':
        console.log('💸 Payment succeeded');
        break;
        
      case 'invoice.payment_failed':
        console.log('❌ Payment failed');
        break;
        
      case 'customer.subscription.created':
        console.log('🔄 Subscription created');
        break;
        
      case 'customer.subscription.deleted':
        console.log('❌ Subscription cancelled');
        // Here you could suspend the server
        break;
        
      default:
        console.log(`❓ Unhandled event type: ${event.type}`);
    }
    
    res.json({ received: true });
  } catch (err) {
    console.error('❌ Event processing error:', {
      error: err.message,
      event: event.type,
      stack: err.stack,
      timestamp: new Date().toISOString()
    });
    res.status(500).json({ error: err.message });
  }
});

// SIMPLE: Get server details for checkout page
app.get('/server-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    console.log('🔍 Retrieving server details for session:', sessionId);
    
    // Get from our database
    const serverDetails = serverDatabase.get(sessionId);
    
    if (!serverDetails) {
      // SIMPLE: Check if the Stripe session exists and payment is complete
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        
        if (session.payment_status === 'paid') {
          // Payment is complete but server not created yet
          return res.status(202).json({ 
            message: 'Server is being deployed. Please wait...',
            status: 'processing',
            sessionId: sessionId,
            paymentStatus: session.payment_status
          });
        } else {
          // Payment not complete yet
          return res.status(400).json({ 
            error: 'Payment not completed',
            status: 'payment_pending',
            sessionId: sessionId,
            paymentStatus: session.payment_status
          });
        }
      } catch (stripeError) {
        console.error('❌ Error retrieving Stripe session:', stripeError.message);
        return res.status(404).json({ error: 'Session not found' });
      }
    }

    // Also get the Stripe session for additional info
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    const response = {
      ...serverDetails,
      paymentStatus: session.payment_status,
      amountTotal: session.amount_total,
      currency: session.currency
    };

    res.json(response);
  } catch (err) {
    console.error('❌ Error retrieving server details:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stripe Checkout Session Creation (EXISTING ENDPOINT - KEEPING SAME)
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { planId, serverConfig } = req.body;

    console.log('🛒 Creating checkout session:', { planId, serverConfig });

    // Validate required fields
    if (!serverConfig.serverName || !serverConfig.serverType || !serverConfig.minecraftVersion) {
      return res.status(400).json({ error: 'Missing required server configuration' });
    }

    // Safe metadata creation with defaults for missing values
    const metadata = {
      serverName: String(serverConfig.serverName || ''),
      planId: String(planId || 'pro'),
      serverType: String(serverConfig.serverType || 'paper'),
      minecraftVersion: String(serverConfig.minecraftVersion || 'latest'),
      maxPlayers: String(serverConfig.maxPlayers || 20),
      totalRam: String(serverConfig.totalRam || 4),
      viewDistance: String(serverConfig.viewDistance || 10),
      enableWhitelist: String(serverConfig.enableWhitelist || false),
      enablePvp: String(serverConfig.enablePvp !== undefined ? serverConfig.enablePvp : true),
      selectedPlugins: Array.isArray(serverConfig.selectedPlugins) ? serverConfig.selectedPlugins.join(',') : '',
      totalCost: String(serverConfig.totalCost || 0)
    };

    console.log('📋 Safe metadata created:', metadata);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Minecraft Server - ${serverConfig.serverName}`,
            description: `${serverConfig.serverType.toUpperCase()} server running Minecraft ${serverConfig.minecraftVersion}`
          },
          unit_amount: Math.round(serverConfig.totalCost * 100), // Convert to cents
          recurring: { interval: 'month' }
        },
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/setup/${encodeURIComponent(serverConfig.serverName)}`,
      
      // Use the safe metadata object
      metadata: metadata
    });

    console.log('✅ Checkout session created:', session.id);
    console.log('📋 Metadata sent to Stripe:', metadata);
    console.log('✅ Checkout session created with URLs:');
    console.log('- Success URL:', `${process.env.FRONTEND_URL}/checkout/success?session_id=${session.id}`);
    console.log('- Cancel URL:', `${process.env.FRONTEND_URL}/setup/${encodeURIComponent(serverConfig.serverName)}`);

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error('❌ Checkout session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get session details endpoint (EXISTING ENDPOINT - KEEPING SAME)
app.get('/session-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    console.log('🔍 Retrieving session details for:', sessionId);
    
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    res.json({
      sessionId: session.id,
      paymentStatus: session.payment_status,
      customerEmail: session.customer_details?.email,
      amountTotal: session.amount_total,
      currency: session.currency,
      metadata: session.metadata,
      createdAt: new Date(session.created * 1000).toISOString()
    });
  } catch (err) {
    console.error('❌ Error retrieving session:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint (EXISTING ENDPOINT - KEEPING SAME)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`🦆 GOOSE HOSTING SERVER`);
  console.log(`====================`);
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔑 Stripe configured: ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌'}`);
  console.log(`🪝 Webhook secret configured: ${process.env.STRIPE_WEBHOOK_SECRET ? '✅' : '❌'}`);
  console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'Not set'}`);
  console.log(`🦆 Pterodactyl API: ${PTERODACTYL_BASE}`);
  console.log(`🔑 Pterodactyl API Key: ${PTERODACTYL_API_KEY ? '✅ Configured' : '❌ Missing'}`);
  console.log(`====================`);
});
