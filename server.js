
// server.js - Complete Updated Version with Server Details Endpoint

require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const PORT = process.env.PORT || 3001;

// Validate required environment variables on startup FIRST
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

// THEN declare constants after validation
const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;
const PTERODACTYL_BASE = process.env.PTERODACTYL_API_URL;

const app = express();

// Store server deployment status in memory (for production, use a database)
const serverDeployments = new Map();

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

// Fetch user/egg/allocation IDs
async function fetchPterodactylMeta(email = 'admin@goosehosting.com') {
  try {
    const usersRes = await axios.get(`${PTERODACTYL_BASE}/users`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    console.log('User API response:', usersRes.data);

    const userData = usersRes.data.data;
    if (!Array.isArray(userData)) throw new Error('Unexpected response format for users');

    const user = userData.find(u => u.attributes.email === email);
    if (!user) throw new Error(`User with email ${email} not found.`);

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

    const allocRes = await axios.get(`${PTERODACTYL_BASE}/nodes/${nodeId}/allocations`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const allocation = allocRes.data.data.find(a => !a.attributes.assigned);
    if (!allocation) throw new Error('No free allocation found.');

    return {
      userId: user.attributes.id,
      eggName: minecraftEgg.attributes.name,
      eggId: minecraftEgg.attributes.id,
      dockerImage: minecraftEgg.attributes.docker_image,
      startup: minecraftEgg.attributes.startup,
      allocationId: allocation.attributes.id,
      allocationIp: allocation.attributes.ip,
      allocationPort: allocation.attributes.port
    };
  } catch (err) {
    console.error('❌ Failed to fetch Pterodactyl meta:', err.message);
    throw err;
  }
}

// Generate random password for new users
function generatePassword(length = 12) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return password;
}

// Create server on Pterodactyl using individual metadata fields
async function createPterodactylServer(session) {
  try {
    console.log('🦆 GOOSE HOSTING - PTERODACTYL DEPLOYMENT');
    console.log('==========================================');
    console.log('📋 Session Metadata:', session.metadata);

    // Mark deployment as starting
    const deploymentKey = `deployment_${session.id}`;
    serverDeployments.set(deploymentKey, {
      status: 'deploying',
      startedAt: new Date().toISOString(),
      sessionId: session.id
    });

    const config = await fetchPterodactylMeta();
    
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

    console.log('✅ Server created successfully!');
    console.log('📦 Server Details:');
    console.log('  • Server ID:', serverId);
    console.log('  • Server UUID:', serverUuid);
    console.log('  • Name:', serverName);
    console.log('  • User ID:', config.userId);
    console.log('  • Allocation ID:', config.allocationId);
    console.log('  • Egg ID:', config.eggId);
    console.log('  • Docker Image:', config.dockerImage);
    console.log('==========================================');

    // Generate credentials for panel access
    const customerEmail = session.customer_details?.email || 'user@goosehosting.com';
    const generatedPassword = generatePassword();

    // Update deployment status with success
    serverDeployments.set(deploymentKey, {
      status: 'completed',
      startedAt: serverDeployments.get(deploymentKey).startedAt,
      completedAt: new Date().toISOString(),
      sessionId: session.id,
      serverId,
      serverUuid,
      serverName,
      serverIp: config.allocationIp,
      serverPort: config.allocationPort,
      panelUrl: process.env.PTERODACTYL_PANEL_URL || 'https://panel.goosehosting.com',
      username: customerEmail,
      password: generatedPassword,
      isNewUser: true,
      customerEmail,
      planId,
      maxPlayers,
      totalRam,
      viewDistance,
      enableWhitelist,
      enablePvp,
      selectedPlugins,
      serverType,
      minecraftVersion
    });

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
      serverIp: config.allocationIp,
      serverPort: config.allocationPort,
      message: 'Server created successfully'
    };

  } catch (err) {
    console.error('❌ Server creation failed:', {
      error: err.message,
      response: err.response?.data,
      status: err.response?.status,
      headers: err.response?.headers
    });
    
    // Mark deployment as failed
    const deploymentKey = `deployment_${session.id}`;
    serverDeployments.set(deploymentKey, {
      status: 'failed',
      startedAt: serverDeployments.get(deploymentKey)?.startedAt || new Date().toISOString(),
      failedAt: new Date().toISOString(),
      sessionId: session.id,
      error: err.message
    });
    
    throw err;
  }
}

// Get server details endpoint - NEW ENDPOINT
app.get('/server-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    console.log('🔍 Retrieving server details for session:', sessionId);
    
    // Get session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Check if payment is complete
    if (session.payment_status !== 'paid') {
      return res.status(202).json({ 
        status: 'payment_pending', 
        message: 'Payment is still processing' 
      });
    }

    // Check deployment status
    const deploymentKey = `deployment_${sessionId}`;
    const deployment = serverDeployments.get(deploymentKey);
    
    if (!deployment) {
      return res.status(202).json({ 
        status: 'processing', 
        message: 'Server is being deployed' 
      });
    }

    if (deployment.status === 'failed') {
      return res.status(500).json({ 
        error: 'Server deployment failed',
        details: deployment.error 
      });
    }

    if (deployment.status === 'deploying') {
      return res.status(202).json({ 
        status: 'processing', 
        message: 'Server is being deployed' 
      });
    }

    // Server is ready - return full details
    const serverDetails = {
      sessionId,
      serverName: deployment.serverName,
      serverType: deployment.serverType,
      minecraftVersion: deployment.minecraftVersion,
      maxPlayers: deployment.maxPlayers,
      totalRam: deployment.totalRam,
      viewDistance: deployment.viewDistance,
      enableWhitelist: deployment.enableWhitelist,
      enablePvp: deployment.enablePvp,
      selectedPlugins: deployment.selectedPlugins || [],
      
      // Server connection details
      serverIp: deployment.serverIp,
      serverPort: deployment.serverPort,
      
      // Panel access details
      panelUrl: deployment.panelUrl,
      username: deployment.username,
      password: deployment.password,
      isNewUser: deployment.isNewUser,
      customerEmail: deployment.customerEmail,
      
      // Timestamps
      createdAt: deployment.startedAt,
      completedAt: deployment.completedAt,
      
      // Status
      status: 'ready'
    };

    console.log('✅ Server details retrieved successfully for session:', sessionId);
    res.json(serverDetails);

  } catch (err) {
    console.error('❌ Error retrieving server details:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

// Stripe Checkout Session Creation - UPDATED to not require email upfront
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
      customer_creation: 'always', // Always create a customer
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
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/setup/${encodeURIComponent(serverConfig.serverName)}`,
      
      // Use the safe metadata object
      metadata: metadata
    });

    console.log('✅ Checkout session created:', session.id);
    console.log('📋 Metadata sent to Stripe:', metadata);

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error('❌ Checkout session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Redirect to Stripe checkout endpoint - NEW
app.get('/checkout/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    console.log('🔗 Redirecting to Stripe checkout for session:', sessionId);
    
    // Get session from Stripe to get the checkout URL
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (!session || !session.url) {
      return res.status(404).json({ error: 'Checkout session not found or expired' });
    }
    
    // Redirect to Stripe's hosted checkout page
    res.redirect(session.url);
    
  } catch (err) {
    console.error('❌ Error redirecting to checkout:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get session details endpoint
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    deploymentsCount: serverDeployments.size
  });
});

// Debug endpoint to view deployments (remove in production)
app.get('/debug/deployments', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  
  const deployments = Array.from(serverDeployments.entries()).map(([key, value]) => ({
    key,
    ...value,
    // Don't expose passwords in debug
    password: value.password ? '***' : undefined
  }));
  
  res.json({ deployments });
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
