const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_SERVERS = 5; // Server capacity limit

// Enhanced CORS configuration
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://goosehosting.com',
    'https://www.goosehosting.com',
    'https://beta.goosehosting.com',
    process.env.FRONTEND_URL
  ].filter(Boolean),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Pterodactyl Configuration
const PTERODACTYL_BASE = process.env.PTERODACTYL_BASE || 'https://panel.goosehosting.com';
const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;

// Utility Functions
function generateServerCredentials(customerEmail, serverName) {
  const serverPassword = generateRandomPassword(16);
  const username = customerEmail ? 
    customerEmail.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase() :
    'server';
  const finalUsername = username + '_' + Date.now().toString().slice(-4);
  
  return {
    username: finalUsername,
    password: serverPassword,
    serverName: serverName
  };
}

function generateRandomPassword(length = 16) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return password;
}

// Fetch Pterodactyl metadata
async function fetchPterodactylMeta(customerEmail) {
  return {
    userId: 1,
    nodeId: 1,
    eggId: 15, // Minecraft Java egg ID
    dockerImage: 'ghcr.io/pterodactyl/yolks:java_17',
    startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -Dterminal.jline=false -Dterminal.ansi=true -jar {{SERVER_JARFILE}}'
  };
}

// Helper function to calculate pricing
function calculatePricing(monthlyPrice, billingCycle, cycle) {
  const totalBeforeDiscount = monthlyPrice * cycle.multiplier;
  const discountAmount = totalBeforeDiscount * cycle.discount;
  const finalPrice = totalBeforeDiscount - discountAmount;

  return {
    monthlyPrice,
    totalBeforeDiscount,
    discountAmount,
    finalPrice,
    cycle
  };
}

// Helper function to create session metadata
function createSessionMetadata(serverConfig, billingCycle, cycle, finalPrice, planId) {
  return {
    planId: planId,
    billingCycle: billingCycle,
    finalPrice: finalPrice.toString(),
    monthlyRate: serverConfig.totalCost.toString(),
    billingMultiplier: cycle.multiplier.toString(),
    billingDiscount: cycle.discount.toString(),
    serverName: serverConfig.serverName,
    serverType: serverConfig.serverType,
    minecraftVersion: serverConfig.minecraftVersion || 'latest',
    totalRam: serverConfig.totalRam?.toString() || '4',
    maxPlayers: serverConfig.maxPlayers?.toString() || '20',
    viewDistance: serverConfig.viewDistance?.toString() || '10',
    enableWhitelist: serverConfig.enableWhitelist?.toString() || 'false',
    enablePvp: serverConfig.enablePvp?.toString() || 'true',
    selectedPlugins: Array.isArray(serverConfig.selectedPlugins) ? serverConfig.selectedPlugins.join(',') : '',
    serverStatus: 'pending',
    createdAt: new Date().toISOString()
  };
}

/* ======================
   PRECHECK ENDPOINT
   ====================== */
app.post('/api/precheck', async (req, res) => {
  console.group('\n🔍 SERVER CAPACITY PRECHECK');
  try {
    const { nodeId } = req.body;
    
    if (!nodeId) {
      console.error('❌ Missing nodeId');
      return res.status(400).json({ 
        error: 'Node ID is required',
        received: req.body 
      });
    }

    console.log('🔄 Querying Pterodactyl API for server count...');
    const serversResponse = await axios.get(`${PTERODACTYL_BASE}/api/application/servers`, {
      headers: {
        'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
        'Accept': 'application/json'
      }
    });

    const currentServerCount = serversResponse.data.meta.pagination.total;
    const remainingCapacity = MAX_SERVERS - currentServerCount;
    
    console.log(`📊 Server Capacity: ${currentServerCount}/${MAX_SERVERS} (${remainingCapacity} remaining)`);

    res.json({
      success: true,
      serverCount: currentServerCount,
      serverLimit: MAX_SERVERS,
      canDeploy: currentServerCount < MAX_SERVERS,
      remainingCapacity,
      message: currentServerCount < MAX_SERVERS 
        ? 'Server can be deployed' 
        : `Server limit reached (${currentServerCount}/${MAX_SERVERS})`
    });

  } catch (error) {
    console.error('❌ Precheck Error:', error);
    res.status(500).json({ 
      error: 'Failed to check server capacity',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    console.groupEnd();
  }
});

/* ======================
   CREATE CHECKOUT SESSION
   ====================== */
app.post('/api/create-checkout-session', async (req, res) => {
  console.group('\n💰 CHECKOUT SESSION CREATION');
  try {
    // First check server count
    const serversResponse = await axios.get(`${PTERODACTYL_BASE}/api/application/servers`, {
      headers: {
        'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
        'Accept': 'application/json'
      }
    });

    const currentServerCount = serversResponse.data.meta.pagination.total;
    const remainingCapacity = MAX_SERVERS - currentServerCount;
    
    console.log(`📊 Current Usage: ${currentServerCount}/${MAX_SERVERS} (${remainingCapacity} remaining)`);

    if (currentServerCount >= MAX_SERVERS) {
      console.error(`🚨 Deployment Blocked: At capacity (${currentServerCount}/${MAX_SERVERS})`);
      return res.status(403).json({
        error: 'Server limit reached',
        serverCount: currentServerCount,
        serverLimit: MAX_SERVERS,
        remainingCapacity: 0,
        message: `Cannot deploy (${currentServerCount}/${MAX_SERVERS} servers in use)`
      });
    }

    const { planId, billingCycle, finalPrice, serverConfig } = req.body;
    
    // Validate input
    const errors = [];
    if (!planId || typeof planId !== 'string') errors.push('Invalid planId');
    if (!billingCycle || typeof billingCycle !== 'string') errors.push('Invalid billingCycle');
    if (!finalPrice || typeof finalPrice !== 'number' || finalPrice <= 0) errors.push('Invalid finalPrice');
    if (!serverConfig || typeof serverConfig !== 'object') errors.push('Invalid serverConfig');

    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }

    // Define billing cycles
    const billingCycles = {
      monthly: { interval: 'month', interval_count: 1, multiplier: 1, discount: 0 },
      quarterly: { interval: 'month', interval_count: 3, multiplier: 3, discount: 0.05 },
      semiannual: { interval: 'month', interval_count: 6, multiplier: 6, discount: 0.10 },
      annual: { interval: 'year', interval_count: 1, multiplier: 12, discount: 0.15 }
    };

    const cycle = billingCycles[billingCycle];
    if (!cycle) {
      return res.status(400).json({ error: 'Invalid billing cycle' });
    }

    // Create price data
    const priceData = {
      currency: 'usd',
      unit_amount: Math.round(finalPrice * 100),
      recurring: {
        interval: cycle.interval,
        interval_count: cycle.interval_count,
      },
      product_data: {
        name: `${serverConfig.serverName} - ${planId.charAt(0).toUpperCase() + planId.slice(1)} Plan`,
        description: `Minecraft server hosting - ${billingCycle} billing`,
        metadata: {
          plan: planId,
          billingCycle: billingCycle,
          serverType: serverConfig.serverType,
          minecraftVersion: serverConfig.minecraftVersion
        }
      }
    };

    // Create session metadata
    const sessionMetadata = createSessionMetadata(serverConfig, billingCycle, cycle, finalPrice, planId);

    // Create Stripe session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price_data: priceData, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/setup/${encodeURIComponent(serverConfig.serverName)}?cancelled=true`,
      metadata: sessionMetadata,
      subscription_data: { metadata: sessionMetadata },
      customer_email: serverConfig.customerEmail || undefined,
      allow_promotion_codes: true
    });

    console.log(`🎉 Checkout created (${currentServerCount + 1}/${MAX_SERVERS} servers will be active)`);
    res.json({
      sessionId: session.id,
      url: session.url,
      capacity: {
        current: currentServerCount,
        limit: MAX_SERVERS,
        remaining: remainingCapacity - 1
      }
    });

  } catch (error) {
    console.error('💥 Checkout Error:', error);
    res.status(500).json({ 
      error: 'Failed to create checkout session',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    console.groupEnd();
  }
});

/* ======================
   WEBHOOK ENDPOINT
   ====================== */
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.warn('⚠️ Webhook secret not configured');
    return res.status(400).send('Webhook secret not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('🔔 Webhook received:', event.type);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log('💳 Payment completed for session:', session.id);
        
        // Create the server
        await createPterodactylServer(session);
        break;

      case 'invoice.payment_succeeded':
        console.log('💰 Recurring payment succeeded:', event.data.object.id);
        break;

      case 'invoice.payment_failed':
        console.log('❌ Payment failed:', event.data.object.id);
        break;

      default:
        console.log('ℹ️ Unhandled event type:', event.type);
    }
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    return res.status(500).send('Webhook processing failed');
  }

  res.json({ received: true });
});

/* ======================
   CREATE PTERODACTYL SERVER
   ====================== */
async function createPterodactylServer(session) {
  console.group('\n🦆 CREATING PTERODACTYL SERVER');
  try {
    console.log('📋 Session Metadata:', session.metadata);

    const customerEmail = session.customer_details?.email || session.customer_email || 'admin@goosehosting.com';
    const config = await fetchPterodactylMeta(customerEmail);
    
    // Generate server credentials
    const credentials = generateServerCredentials(customerEmail, session.metadata.serverName);

    // Mock server creation (replace with actual Pterodactyl API calls)
    const serverId = Math.floor(Math.random() * 10000);
    const serverUuid = `${serverId}-${Date.now()}`;
    const serverPort = 25565 + serverId;
    const serverAddress = `mc.goosehosting.com:${serverPort}`;

    console.log('🌐 Server Address:', serverAddress);
    console.log('✅ Server created successfully!');

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
        updatedAt: new Date().toISOString()
      }
    });

    return {
      success: true,
      serverId,
      serverUuid,
      serverAddress,
      credentials
    };

  } catch (err) {
    console.error('❌ Server creation failed:', err);
    throw err;
  } finally {
    console.groupEnd();
  }
}

/* ======================
   DEPLOYMENT STATUS ENDPOINT
   ====================== */
app.get('/api/deployment-status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    res.json({
      status: session.metadata.serverStatus || 'pending',
      serverName: session.metadata.serverName,
      address: session.metadata.serverAddress,
      panelUrl: session.metadata.panelUrl,
      createdAt: session.metadata.createdAt,
      updatedAt: session.metadata.updatedAt
    });
  } catch (error) {
    console.error('Error checking deployment status:', error);
    res.status(500).json({ error: 'Failed to check deployment status' });
  }
});

/* ======================
   HEALTH CHECK
   ====================== */
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      stripe: !!process.env.STRIPE_SECRET_KEY,
      pterodactyl: !!PTERODACTYL_API_KEY
    },
    limits: {
      maxServers: MAX_SERVERS
    }
  });
});

/* ======================
   ERROR HANDLING
   ====================== */
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

/* ======================
   SERVER STARTUP
   ====================== */
app.listen(PORT, () => {
  console.log('\n🦆 === GOOSE HOSTING BACKEND ===');
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? 'Ready' : 'Disabled'}`);
  console.log(`🦅 Pterodactyl: ${PTERODACTYL_API_KEY ? 'Connected' : 'Disabled'}`);
  console.log(`🚦 Server Limit: ${MAX_SERVERS}`);
  console.log('===============================');
});
