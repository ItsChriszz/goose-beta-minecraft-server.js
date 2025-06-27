const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_SERVERS = 5; // Server capacity limit

// FIXED: Enhanced CORS configuration with better error handling
const corsOptions = {
  origin: [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:4173',
    'https://goosehosting.com',
    'https://www.goosehosting.com',
    'https://beta.goosehosting.com',
    process.env.FRONTEND_URL
  ].filter(Boolean),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'Accept',
    'Origin',
    'X-Requested-With',
    'stripe-signature'
  ],
  optionsSuccessStatus: 200 // Some legacy browsers choke on 204
};

// Apply CORS middleware BEFORE other middlewares
app.use(cors(corsOptions));

// FIXED: Explicitly handle preflight OPTIONS requests
app.options('*', cors(corsOptions));

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// FIXED: Enhanced request logging middleware
app.use((req, res, next) => {
  console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.path}`);
  console.log('Origin:', req.get('Origin') || 'No origin header');
  console.log('User-Agent:', req.get('User-Agent') || 'No user agent');
  
  if (req.method === 'POST') {
    console.log('Body keys:', Object.keys(req.body || {}));
  }
  
  // FIXED: Add response headers for debugging
  res.on('finish', () => {
    console.log(`Response: ${res.statusCode} ${res.statusMessage}`);
  });
  
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
    // FIXED: Use correct field name that matches frontend
    serverType: serverConfig.serverType || serverConfig.selectedServerType,
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
   TEST ENDPOINT - ENHANCED
   ====================== */
app.get('/api/test', (req, res) => {
  console.log('🔍 Test endpoint hit!');
  res.json({ 
    message: 'Backend is working!', 
    timestamp: new Date().toISOString(),
    cors: 'enabled',
    environment: process.env.NODE_ENV || 'development',
    port: PORT,
    stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
    corsOrigins: corsOptions.origin,
    requestOrigin: req.get('Origin'),
    requestMethod: req.method,
    requestHeaders: req.headers
  });
});

/* ======================
   CREATE CHECKOUT SESSION - ENHANCED ERROR HANDLING
   ====================== */
app.post('/api/create-checkout-session', async (req, res) => {
  console.group('\n💰 CHECKOUT SESSION CREATION');
  console.log('📋 Request Origin:', req.get('Origin'));
  console.log('📋 Request Method:', req.method);
  console.log('📋 Request Headers:', req.headers);
  
  try {
    const { planId, billingCycle, finalPrice, serverConfig } = req.body;
    
    console.log('📋 Request Data:');
    console.log('  • planId:', planId);
    console.log('  • billingCycle:', billingCycle);
    console.log('  • finalPrice:', finalPrice);
    console.log('  • serverConfig keys:', Object.keys(serverConfig || {}));
    console.log('  • Full serverConfig:', JSON.stringify(serverConfig, null, 2));
    
    // FIXED: Enhanced validation
    const errors = [];
    if (!planId || typeof planId !== 'string') errors.push('Invalid planId');
    if (!billingCycle || typeof billingCycle !== 'string') errors.push('Invalid billingCycle');
    if (!finalPrice || typeof finalPrice !== 'number' || finalPrice <= 0) errors.push('Invalid finalPrice');
    if (!serverConfig || typeof serverConfig !== 'object') errors.push('Invalid serverConfig');

    // FIXED: Validate serverConfig fields with better error messages
    if (serverConfig) {
      if (!serverConfig.serverName || !serverConfig.serverName.trim()) {
        errors.push('Server name is required and cannot be empty');
      }
      
      // FIXED: Check for both possible field names
      const serverType = serverConfig.serverType || serverConfig.selectedServerType;
      if (!serverType) {
        errors.push('Server type is required (serverType or selectedServerType field)');
      }
      
      if (!serverConfig.minecraftVersion) {
        errors.push('Minecraft version is required');
      }
      
      if (typeof serverConfig.totalCost !== 'number' || serverConfig.totalCost <= 0) {
        errors.push('Invalid total cost - must be a positive number');
      }
      
      // Add more detailed validation
      if (typeof serverConfig.totalRam !== 'number' || serverConfig.totalRam <= 0) {
        errors.push('Total RAM must be a positive number');
      }
      
      if (typeof serverConfig.maxPlayers !== 'number' || serverConfig.maxPlayers <= 0) {
        errors.push('Max players must be a positive number');
      }
    }

    if (errors.length > 0) {
      console.error('❌ Validation errors:', errors);
      return res.status(400).json({ 
        error: 'Validation failed',
        errors: errors,
        receivedData: {
          planId,
          billingCycle,
          finalPrice,
          serverConfigKeys: Object.keys(serverConfig || {})
        }
      });
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
      return res.status(400).json({ error: 'Invalid billing cycle', validCycles: Object.keys(billingCycles) });
    }

    // FIXED: Ensure we have Stripe configured
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('❌ Stripe secret key not configured');
      return res.status(500).json({ 
        error: 'Payment system not configured',
        details: 'Stripe secret key missing'
      });
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
          serverType: serverConfig.serverType || serverConfig.selectedServerType,
          minecraftVersion: serverConfig.minecraftVersion
        }
      }
    };

    // Create session metadata
    const sessionMetadata = createSessionMetadata(serverConfig, billingCycle, cycle, finalPrice, planId);

    console.log('💳 Creating Stripe session with:', {
      priceData,
      sessionMetadata
    });

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

    console.log('🎉 Checkout session created:', session.id);
    
    // FIXED: Send proper CORS response
    res.json({
      sessionId: session.id,
      url: session.url,
      success: true
    });

  } catch (error) {
    console.error('💥 Checkout Error:', error);
    console.error('💥 Error stack:', error.stack);
    
    // FIXED: Better error response
    const errorResponse = {
      error: 'Failed to create checkout session',
      message: error.message,
      timestamp: new Date().toISOString()
    };
    
    if (process.env.NODE_ENV === 'development') {
      errorResponse.details = error.stack;
    }
    
    res.status(500).json(errorResponse);
  } finally {
    console.groupEnd();
  }
});

/* ======================
   SESSION DETAILS ENDPOINT
   ====================== */
app.get('/api/session-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    console.log('🔍 Fetching session details for:', sessionId);
    
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }
    
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer', 'subscription']
    });
    
    res.json({
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      customer_email: session.customer_details?.email || session.customer_email,
      amount_total: session.amount_total,
      currency: session.currency,
      metadata: session.metadata,
      created: session.created,
      url: session.url
    });
  } catch (error) {
    console.error('Error fetching session details:', error);
    res.status(500).json({ 
      error: 'Failed to fetch session details',
      message: error.message 
    });
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
    console.log('🔑 Credentials:', credentials);
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
        ftpHost: 'ftp.goosehosting.com',
        ftpPort: '21',
        ftpUsername: credentials.username,
        ftpPassword: credentials.password,
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
    
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }
    
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
    res.status(500).json({ 
      error: 'Failed to check deployment status',
      message: error.message 
    });
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
    },
    cors: {
      enabled: true,
      origins: corsOptions.origin
    },
    environment: process.env.NODE_ENV || 'development'
  });
});

/* ======================
   ERROR HANDLING - ENHANCED
   ====================== */
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  console.error('❌ Request details:', {
    method: req.method,
    url: req.url,
    origin: req.get('Origin'),
    userAgent: req.get('User-Agent')
  });
  
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
    timestamp: new Date().toISOString()
  });
});

// FIXED: 404 Handler with better debugging (MUST BE LAST)
app.use((req, res) => {
  console.log('❌ 404 - Route not found:', {
    method: req.method,
    path: req.path,
    url: req.url,
    origin: req.get('Origin'),
    userAgent: req.get('User-Agent'),
    headers: req.headers
  });
  
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
    availableEndpoints: [
      'GET /api/test',
      'POST /api/create-checkout-session',
      'GET /api/session-details/:sessionId',
      'POST /api/webhook',
      'GET /api/deployment-status/:sessionId',
      'GET /api/health'
    ],
    suggestion: `Did you mean to request one of the available endpoints? Current request: ${req.method} ${req.path}`
  });
});

/* ======================
   SERVER STARTUP - ENHANCED
   ====================== */
app.listen(PORT, () => {
  console.log('\n🦆 === GOOSE HOSTING BACKEND ===');
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? 'Ready' : 'Disabled'}`);
  console.log(`🦅 Pterodactyl: ${PTERODACTYL_API_KEY ? 'Connected' : 'Disabled'}`);
  console.log(`🚦 Server Limit: ${MAX_SERVERS}`);
  console.log(`🔗 CORS Origins: ${JSON.stringify(corsOptions.origin)}`);
  console.log('===============================');
  console.log(`🔍 Test endpoint: http://localhost:${PORT}/api/test`);
  console.log(`🔍 Health check: http://localhost:${PORT}/api/health`);
  console.log('===============================\n');
});
