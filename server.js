require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const PORT = process.env.PORT || 3001;
const API_BASE_URL = process.env.API_BASE_URL || 'https://stripeapibeta.goosehosting.com';

// Environment variable check with detailed logging
console.log('🔍 Environment Check:');
console.log('STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY ? 'Set (' + process.env.STRIPE_SECRET_KEY.substring(0, 8) + '...)' : 'NOT SET');
console.log('PTERODACTYL_API_KEY:', process.env.PTERODACTYL_API_KEY ? 'Set' : 'NOT SET');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL || 'NOT SET');

// Validate environment variables
const requiredEnvVars = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PTERODACTYL_API_KEY',
  'PTERODACTYL_API_URL',
  'FRONTEND_URL'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const app = express();

// Enhanced CORS configuration
const corsOptions = {
  origin: [process.env.FRONTEND_URL, 'http://localhost:5173', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization',
    'X-Requested-With',
    'Accept'
  ],
  credentials: true,
  optionsSuccessStatus: 200
};

// Middleware
app.use(bodyParser.json());
app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Stripe webhook needs raw body
app.use('/webhook', 
  bodyParser.raw({ type: 'application/json' }),
  cors(corsOptions)
);

// Helper functions
const generateCredentials = () => {
  const password = require('crypto').randomBytes(16).toString('hex');
  const username = `user${Math.floor(Math.random() * 10000)}`;
  return { username, password };
};

// Pterodactyl API wrapper with better error handling
const pterodactylRequest = async (method, endpoint, data = null) => {
  try {
    console.log(`🦆 Pterodactyl API: ${method.toUpperCase()} ${endpoint}`);
    const response = await axios({
      method,
      url: `${process.env.PTERODACTYL_API_URL}${endpoint}`,
      headers: {
        'Authorization': `Bearer ${process.env.PTERODACTYL_API_KEY}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      data,
      timeout: 30000 // 30 second timeout
    });
    return response.data;
  } catch (error) {
    console.error('❌ Pterodactyl API Error:', {
      endpoint,
      method,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    throw error;
  }
};

// Server creation logic with better error handling
const createMinecraftServer = async (session) => {
  const { customer_details, metadata } = session;
  const email = customer_details?.email || metadata?.customerEmail;
  
  console.log('🚀 Creating Minecraft server for session:', session.id);
  console.log('📧 Customer email:', email);
  console.log('📋 Metadata:', metadata);
  
  if (!email) {
    throw new Error('No customer email available in session');
  }

  let user;
  try {
    // 1. Find or create user
    console.log('👤 Looking for existing user...');
    const users = await pterodactylRequest('get', '/users');
    const existingUser = users.data.find(u => u.attributes.email === email);
    
    if (existingUser) {
      console.log('✅ Found existing user:', existingUser.attributes.username);
      user = {
        id: existingUser.attributes.id,
        username: existingUser.attributes.username,
        isNew: false
      };
    } else {
      console.log('👤 Creating new user...');
      const { username, password } = generateCredentials();
      const newUser = await pterodactylRequest('post', '/users', {
        email,
        username,
        first_name: 'Minecraft',
        last_name: 'Player',
        password
      });
      
      console.log('✅ Created new user:', username);
      user = {
        id: newUser.attributes.id,
        username,
        password,
        isNew: true
      };
    }
  } catch (error) {
    console.error('❌ User creation failed:', error);
    throw new Error(`Failed to setup user account: ${error.message}`);
  }

  try {
    // 2. Get server resources
    console.log('🔍 Getting server resources...');
    const [eggs, nodes] = await Promise.all([
      pterodactylRequest('get', '/nests/1/eggs'),
      pterodactylRequest('get', '/nodes')
    ]);

    const minecraftEgg = eggs.data.find(e => 
      e.attributes.name.toLowerCase().includes('minecraft') ||
      e.attributes.name.toLowerCase().includes('paper') ||
      e.attributes.name.toLowerCase().includes('vanilla')
    );
    
    if (!minecraftEgg) {
      console.error('❌ Available eggs:', eggs.data.map(e => e.attributes.name));
      throw new Error('No Minecraft egg found');
    }
    
    console.log('🥚 Using egg:', minecraftEgg.attributes.name);
    
    const node = nodes.data.find(n => n.attributes.public === true) || nodes.data[0];
    if (!node) {
      throw new Error('No available nodes found');
    }
    
    console.log('🖥️ Using node:', node.attributes.name);
    
    const allocations = await pterodactylRequest(
      'get', 
      `/nodes/${node.attributes.id}/allocations`
    );
    
    const allocation = allocations.data.find(a => !a.attributes.assigned);
    if (!allocation) {
      throw new Error('No available allocations found');
    }
    
    console.log('🔌 Using allocation:', `${allocation.attributes.ip}:${allocation.attributes.port}`);

    // 3. Create server
    console.log('🏗️ Creating server...');
    const serverConfig = {
      name: metadata.serverName || `mc-${Date.now()}`,
      user: user.id,
      egg: minecraftEgg.attributes.id,
      docker_image: minecraftEgg.attributes.docker_image,
      startup: minecraftEgg.attributes.startup,
      environment: {
        SERVER_JARFILE: 'server.jar',
        VERSION: metadata.minecraftVersion || 'latest',
        SERVER_MEMORY: (parseInt(metadata.totalRam) || 4) * 1024,
        BUILD_TYPE: metadata.serverType || 'paper'
      },
      limits: {
        memory: (parseInt(metadata.totalRam) || 4) * 1024,
        disk: 5120,
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

    console.log('📝 Server config:', serverConfig);
    const server = await pterodactylRequest('post', '/servers', serverConfig);
    
    console.log('✅ Server created successfully:', server.attributes.identifier);
    
    return {
      serverId: server.attributes.id,
      identifier: server.attributes.identifier,
      name: server.attributes.name,
      serverIp: allocation.attributes.ip,
      serverPort: allocation.attributes.port,
      username: user.username,
      password: user.isNew ? user.password : undefined,
      panelUrl: process.env.PTERODACTYL_API_URL.replace('/api/application', ''),
      serverName: metadata.serverName,
      serverType: metadata.serverType,
      minecraftVersion: metadata.minecraftVersion,
      totalRam: metadata.totalRam,
      maxPlayers: metadata.maxPlayers,
      viewDistance: metadata.viewDistance,
      enablePvp: metadata.enablePvp === 'true',
      enableWhitelist: metadata.enableWhitelist === 'true',
      selectedPlugins: metadata.selectedPlugins ? metadata.selectedPlugins.split(',') : [],
      isNewUser: user.isNew
    };
  } catch (error) {
    console.error('❌ Server creation failed:', error);
    throw new Error(`Failed to create server: ${error.message}`);
  }
};

// NEW FUNCTION: Handle checkout session completion
async function handleCheckoutCompleted(session) {
  console.log('🔄 Processing checkout session completion...');
  
  try {
    await stripe.checkout.sessions.update(session.id, {
      metadata: {
        ...session.metadata,
        checkoutCompleted: 'true',
        checkoutCompletedAt: new Date().toISOString()
      }
    });
    console.log('✅ Checkout session marked as completed');
  } catch (error) {
    console.error('❌ Failed to update checkout session:', error);
  }
}

// NEW FUNCTION: Handle invoice payment - THIS IS WHERE SERVER CREATION HAPPENS
async function handleInvoicePaymentSucceeded(invoice) {
  console.log('🔄 Processing successful payment...');
  
  try {
    // Get the subscription
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    console.log('📋 Found subscription:', subscription.id);
    
    // Find the checkout session that created this subscription
    const sessions = await stripe.checkout.sessions.list({
      subscription: subscription.id,
      limit: 1
    });
    
    if (!sessions.data || sessions.data.length === 0) {
      console.error('❌ No checkout session found for subscription:', subscription.id);
      return;
    }
    
    const session = sessions.data[0];
    console.log('🎯 Found checkout session:', session.id);
    
    // Check if server already created
    if (session.metadata.serverCreated === 'true') {
      console.log('✅ Server already created for session:', session.id);
      return;
    }
    
    // Create the server now that payment is confirmed
    console.log('🚀 Creating server for paid session...');
    const serverDetails = await createMinecraftServer(session);
    
    // Update session metadata with server details
    await stripe.checkout.sessions.update(session.id, {
      metadata: {
        ...session.metadata,
        serverCreated: 'true',
        serverIp: serverDetails.serverIp,
        serverPort: serverDetails.serverPort,
        serverId: serverDetails.serverId,
        serverIdentifier: serverDetails.identifier,
        paymentConfirmedAt: new Date().toISOString()
      }
    });
    
    console.log('✅ Server created and session updated for:', session.id);
    
  } catch (error) {
    console.error('❌ Failed to process invoice payment:', error);
    throw error;
  }
}

// FIXED API Endpoint - Create Checkout Session
app.post('/create-checkout-session', async (req, res) => {
  try {
    console.log('💳 Creating checkout session...');
    console.log('📋 Request body:', JSON.stringify(req.body, null, 2));
    
    const { serverConfig, planId } = req.body;
    
    if (!serverConfig?.serverName) {
      return res.status(400).json({ 
        error: 'Server name is required',
        code: 'MISSING_SERVER_NAME'
      });
    }

    // Calculate price based on plan
    const planPrices = {
      starter: 499, // $4.99
      pro: 999,     // $9.99
      elite: 1999   // $19.99
    };

    // Get base RAM for each plan
    const planBaseRam = {
      starter: 2,
      pro: 4,
      elite: 8
    };

    const basePrice = planPrices[planId] || planPrices.pro;
    const basePlanRam = planBaseRam[planId] || planBaseRam.pro;
    
    // Fix: Use totalRam from frontend, calculate additional properly
    const totalRam = parseInt(serverConfig.totalRam) || basePlanRam;
    const additionalRam = Math.max(0, totalRam - basePlanRam);
    const additionalRamCost = Math.round(additionalRam * 225); // $2.25 per GB = 225 cents
    
    const totalPrice = basePrice + additionalRamCost;

    console.log('💰 Pricing calculation:', {
      plan: planId,
      basePrice: basePrice + ' cents',
      basePlanRam: basePlanRam + 'GB',
      totalRam: totalRam + 'GB', 
      additionalRam: additionalRam + 'GB',
      additionalRamCost: additionalRamCost + ' cents',
      totalPrice: totalPrice + ' cents'
    });

    // Validation: Make sure totalPrice is a valid integer
    if (!Number.isInteger(totalPrice) || totalPrice <= 0) {
      console.error('❌ Invalid total price:', totalPrice);
      return res.status(400).json({
        error: 'Invalid pricing calculation',
        code: 'INVALID_PRICE',
        details: { totalPrice, basePrice, additionalRamCost }
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Minecraft Server - ${serverConfig.serverName}`,
            description: `${planId.charAt(0).toUpperCase() + planId.slice(1)} plan with ${totalRam}GB RAM`
          },
          unit_amount: totalPrice, // This must be a valid integer
          recurring: { interval: 'month' }
        },
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}`,
      customer_email: serverConfig.customerEmail,
      metadata: {
        ...serverConfig,
        planId,
        totalRam: String(totalRam),
        additionalRam: String(additionalRam),
        basePrice: String(basePrice),
        additionalRamCost: String(additionalRamCost),
        minecraftVersion: serverConfig.minecraftVersion || 'latest',
        serverType: serverConfig.serverType || 'paper',
        maxPlayers: String(serverConfig.maxPlayers || 20),
        viewDistance: String(serverConfig.viewDistance || 10),
        enablePvp: String(serverConfig.enablePvp || true),
        enableWhitelist: String(serverConfig.enableWhitelist || false),
        selectedPlugins: Array.isArray(serverConfig.selectedPlugins) ? serverConfig.selectedPlugins.join(',') : ''
      }
    });

    console.log('✅ Checkout session created:', session.id);

    res.json({ 
      sessionId: session.id,
      url: session.url 
    });

  } catch (error) {
    console.error('❌ Checkout error:', error);
    res.status(500).json({ 
      error: error.message,
      code: 'CHECKOUT_ERROR'
    });
  }
});

// Debug endpoint for troubleshooting
app.post('/debug/pricing', async (req, res) => {
  try {
    const { serverConfig, planId } = req.body;
    
    console.log('🔍 Debug pricing calculation:');
    console.log('Input serverConfig:', JSON.stringify(serverConfig, null, 2));
    console.log('Input planId:', planId);
    
    const planPrices = {
      starter: 499, // $4.99
      pro: 999,     // $9.99
      elite: 1999   // $19.99
    };

    const planBaseRam = {
      starter: 2,
      pro: 4,
      elite: 8
    };

    const basePrice = planPrices[planId] || planPrices.pro;
    const basePlanRam = planBaseRam[planId] || planBaseRam.pro;
    
    const totalRam = parseInt(serverConfig.totalRam) || basePlanRam;
    const additionalRam = Math.max(0, totalRam - basePlanRam);
    const additionalRamCost = Math.round(additionalRam * 225);
    
    const totalPrice = basePrice + additionalRamCost;
    
    const result = {
      inputs: {
        planId,
        totalRamFromFrontend: serverConfig.totalRam,
        serverConfigType: typeof serverConfig.totalRam
      },
      calculations: {
        basePrice,
        basePlanRam,
        totalRam,
        additionalRam,
        additionalRamCost,
        totalPrice
      },
      validation: {
        isPriceInteger: Number.isInteger(totalPrice),
        isPricePositive: totalPrice > 0,
        priceInDollars: (totalPrice / 100).toFixed(2)
      }
    };
    
    console.log('📊 Pricing result:', JSON.stringify(result, null, 2));
    
    res.json(result);
    
  } catch (error) {
    console.error('❌ Debug pricing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ENHANCED server-details endpoint
app.get('/server-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    console.log('='.repeat(50));
    console.log(`🔍 SERVER DETAILS REQUEST`);
    console.log(`📋 Session ID: ${sessionId}`);
    console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
    console.log('='.repeat(50));
    
    // Validate session ID format
    if (!sessionId || !sessionId.startsWith('cs_')) {
      console.log('❌ Invalid session ID format:', sessionId);
      return res.status(400).json({ 
        error: 'Invalid session ID format',
        code: 'INVALID_SESSION_ID'
      });
    }

    // Retrieve session from Stripe
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['customer', 'subscription']
      });
      console.log('✅ Session retrieved successfully');
    } catch (stripeError) {
      console.error('❌ Stripe session retrieval failed:', stripeError.message);
      return res.status(404).json({ 
        error: 'Session not found',
        code: 'STRIPE_SESSION_NOT_FOUND'
      });
    }

    // Check session status
    console.log(`💳 Session status: ${session.status}`);
    console.log(`💰 Payment status: ${session.payment_status}`);
    
    // Case 1: Session not completed yet
    if (session.status !== 'complete') {
      console.log('⏳ Session not completed yet');
      return res.status(202).json({ 
        status: 'session_pending',
        message: 'Checkout session not completed yet'
      });
    }
    
    // Case 2: Session complete but payment still processing
    if (session.payment_status !== 'paid') {
      console.log('💸 Payment still processing');
      return res.status(202).json({ 
        status: 'payment_pending',
        paymentStatus: session.payment_status,
        message: 'Payment is being processed'
      });
    }
    
    // Case 3: Payment complete, check server status
    console.log('✅ Payment completed, checking server status...');
    
    if (session.metadata.serverCreated === 'true') {
      console.log('🎉 Server already created, returning details');
      return res.json({
        status: 'ready',
        server: {
          serverName: session.metadata.serverName,
          serverIp: session.metadata.serverIp,
          serverPort: session.metadata.serverPort,
          serverId: session.metadata.serverId,
          identifier: session.metadata.serverIdentifier,
          panelUrl: process.env.PTERODACTYL_API_URL.replace('/api/application', ''),
          serverType: session.metadata.serverType,
          minecraftVersion: session.metadata.minecraftVersion,
          totalRam: session.metadata.totalRam,
          maxPlayers: session.metadata.maxPlayers,
          viewDistance: session.metadata.viewDistance,
          enablePvp: session.metadata.enablePvp === 'true',
          enableWhitelist: session.metadata.enableWhitelist === 'true',
          selectedPlugins: session.metadata.selectedPlugins ? session.metadata.selectedPlugins.split(',') : []
        }
      });
    }
    
    // Case 4: Payment complete but server not created yet
    console.log('🔄 Payment complete, server creation pending...');
    
    // Check if subscription exists and is active
    if (session.subscription) {
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      console.log(`📋 Subscription status: ${subscription.status}`);
      
      if (subscription.status === 'active') {
        // Payment is confirmed, trigger server creation
        console.log('🚀 Triggering server creation...');
        
        try {
          const serverDetails = await createMinecraftServer(session);
          
          // Update session metadata
          await stripe.checkout.sessions.update(sessionId, {
            metadata: {
              ...session.metadata,
              serverCreated: 'true',
              serverIp: serverDetails.serverIp,
              serverPort: serverDetails.serverPort,
              serverId: serverDetails.serverId,
              serverIdentifier: serverDetails.identifier
            }
          });

          console.log('✅ Server created successfully');
          return res.json({
            status: 'ready',
            server: serverDetails
          });
          
        } catch (serverError) {
          console.error('❌ Server creation failed:', serverError.message);
          return res.status(500).json({
            error: 'Server deployment failed',
            details: serverError.message,
            code: 'SERVER_CREATION_FAILED'
          });
        }
      }
    }
    
    // Case 5: Still waiting for payment confirmation
    console.log('⏳ Waiting for payment confirmation...');
    return res.status(202).json({ 
      status: 'payment_confirming',
      message: 'Payment received, waiting for confirmation. This usually takes 30-60 seconds.'
    });

  } catch (error) {
    console.error('❌ Unexpected error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      code: 'SERVER_DETAILS_ERROR'
    });
  }
});

// Enhanced debug endpoint to check sessions
app.get('/debug/sessions', async (req, res) => {
  try {
    console.log('📋 Listing recent Stripe sessions...');
    
    const sessions = await stripe.checkout.sessions.list({
      limit: 10,
      expand: ['data.customer']
    });
    
    const sessionSummary = sessions.data.map(session => ({
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      customer_email: session.customer_details?.email,
      amount: session.amount_total,
      created: new Date(session.created * 1000).toISOString(),
      metadata_keys: Object.keys(session.metadata || {})
    }));
    
    res.json({
      total_sessions: sessions.data.length,
      sessions: sessionSummary,
      environment: {
        stripe_key_type: process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ? 'test' : 'live'
      }
    });
    
  } catch (error) {
    console.error('❌ Failed to list sessions:', error.message);
    res.status(500).json({
      error: error.message,
      type: error.type
    });
  }
});

// Enhanced debug endpoint for specific sessions
app.get('/debug/stripe/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    console.log('🔍 Debug request for session:', sessionId);
    
    // Test Stripe connection first
    try {
      const balance = await stripe.balance.retrieve();
      console.log('✅ Stripe connection successful');
    } catch (connectionError) {
      console.error('❌ Stripe connection failed:', connectionError.message);
      return res.status(500).json({
        error: 'Stripe connection failed',
        details: connectionError.message,
        suggestion: 'Check your STRIPE_SECRET_KEY environment variable'
      });
    }
    
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer', 'subscription']
    });
    
    console.log('✅ Session found:', {
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      customer_email: session.customer_details?.email,
      metadata_keys: Object.keys(session.metadata || {})
    });
    
    res.json({
      session: {
        id: session.id,
        status: session.status,
        payment_status: session.payment_status,
        metadata: session.metadata,
        customer_details: session.customer_details,
        amount_total: session.amount_total,
        currency: session.currency,
        created: new Date(session.created * 1000).toISOString(),
        stripe_account: session.livemode ? 'live' : 'test'
      },
      environment: {
        stripe_key_type: process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ? 'test' : 'live',
        api_base_url: API_BASE_URL,
        frontend_url: process.env.FRONTEND_URL
      }
    });
  } catch (error) {
    console.error('❌ Debug session error:', error.message);
    res.status(500).json({ 
      error: error.message,
      type: error.type,
      code: error.code,
      suggestion: error.type === 'StripeInvalidRequestError' ? 
        'Session may not exist or there might be a test/live key mismatch' : 
        'Check server logs for more details'
    });
  }
});

// ENHANCED Stripe webhook handler
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Webhook verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  console.log(`📨 Webhook received: ${event.type}`);
  
  try {
    // Handle different event types
    switch (event.type) {
      case 'checkout.session.completed':
        console.log('✅ Checkout session completed:', event.data.object.id);
        await handleCheckoutCompleted(event.data.object);
        break;
        
      case 'invoice.payment_succeeded':
        console.log('💰 Payment succeeded for invoice:', event.data.object.id);
        await handleInvoicePaymentSucceeded(event.data.object);
        break;
        
      case 'customer.subscription.created':
        console.log('📋 Subscription created:', event.data.object.id);
        break;
        
      case 'invoice.payment_failed':
        console.log('❌ Payment failed:', event.data.object.id);
        break;
        
      default:
        console.log(`🤷 Unhandled event type: ${event.type}`);
    }
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }

  res.json({ received: true });
});

// Health check endpoint with full environment info
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    api: API_BASE_URL,
    stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing',
    stripe_mode: process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ? 'test' : 'live',
    pterodactyl: process.env.PTERODACTYL_API_URL,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    version: '2.2.0', // Updated version
    endpoints: [
      'POST /create-checkout-session',
      'GET /server-details/:sessionId',
      'GET /debug/stripe/:sessionId',
      'GET /debug/sessions',
      'POST /debug/pricing',
      'GET /health',
      'POST /webhook'
    ]
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('🚨 Global error handler:', err);
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_SERVER_ERROR',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
    timestamp: new Date().toISOString()
  });
});

// 404 handler with available endpoints
app.use((req, res) => {
  console.log(`❌ 404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({
    error: 'Route not found',
    code: 'NOT_FOUND',
    path: req.path,
    method: req.method,
    available_endpoints: [
      'POST /create-checkout-session',
      'GET /server-details/:sessionId',
      'GET /debug/stripe/:sessionId',
      'GET /debug/sessions',
      'POST /debug/pricing',
      'GET /health',
      'POST /webhook'
    ],
    message: 'The requested endpoint does not exist on this server',
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log('🦆 GoosePanel Backend Server Started!');
  console.log('==========================================');
  console.log(`🚀 Server running on ${API_BASE_URL}`);
  console.log(`🔗 CORS enabled for: ${process.env.FRONTEND_URL}`);
  console.log(`💳 Stripe mode: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_test') ? 'TEST' : 'LIVE'}`);
  console.log(`🎮 Pterodactyl API: ${process.env.PTERODACTYL_API_URL}`);
  console.log(`📧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Version: 2.2.0 (Fixed pricing calculation)`);
  console.log('==========================================');
  console.log('Available endpoints:');
  console.log('  POST /create-checkout-session');
  console.log('  GET  /server-details/:sessionId');
  console.log('  GET  /debug/stripe/:sessionId');
  console.log('  GET  /debug/sessions');
  console.log('  POST /debug/pricing');
  console.log('  GET  /health');
  console.log('  POST /webhook');
  console.log('==========================================');
});
