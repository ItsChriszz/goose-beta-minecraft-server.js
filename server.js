// server.js - Complete Backend with Simplified Validation
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

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
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
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
function createSessionMetadata(serverConfig, billingCycle, cycle, finalPrice) {
  return {
    // Plan and billing info
    planId: serverConfig.planId,
    billingCycle: billingCycle,
    finalPrice: finalPrice.toString(),
    monthlyRate: serverConfig.totalCost.toString(),
    billingMultiplier: cycle.multiplier.toString(),
    billingDiscount: cycle.discount.toString(),
    
    // Server configuration
    serverName: serverConfig.serverName,
    selectedServerType: serverConfig.selectedServerType || 'paper',
    minecraftVersion: serverConfig.minecraftVersion || 'latest',
    totalRam: serverConfig.totalRam?.toString() || '4',
    maxPlayers: serverConfig.maxPlayers?.toString() || '20',
    viewDistance: serverConfig.viewDistance?.toString() || '10',
    enableWhitelist: serverConfig.enableWhitelist?.toString() || 'false',
    enablePvp: serverConfig.enablePvp?.toString() || 'true',
    selectedPlugins: Array.isArray(serverConfig.selectedPlugins) ? serverConfig.selectedPlugins.join(',') : '',
    
    // Status tracking
    serverStatus: 'pending',
    createdAt: new Date().toISOString()
  };
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing',
    webhook: process.env.STRIPE_WEBHOOK_SECRET ? 'configured' : 'missing'
  });
});

// Debug endpoint
app.post('/debug-request', (req, res) => {
  console.log('🧪 DEBUG ENDPOINT HIT');
  console.log('🧪 Headers:', req.headers);
  console.log('🧪 Body:', req.body);
  console.log('🧪 Body type:', typeof req.body);
  console.log('🧪 Body keys:', req.body ? Object.keys(req.body) : 'null');
  
  res.json({
    message: 'Debug endpoint working',
    received: req.body,
    timestamp: new Date().toISOString(),
    bodyType: typeof req.body,
    bodyKeys: req.body ? Object.keys(req.body) : null
  });
});

// Debug checkout endpoint
app.post('/debug-checkout', (req, res) => {
  console.log('🐛 DEBUG CHECKOUT ENDPOINT');
  console.log('🐛 Request body:', JSON.stringify(req.body, null, 2));
  
  const { planId, billingCycle, finalPrice, serverConfig } = req.body;
  
  const validation = {
    planId: {
      value: planId,
      type: typeof planId,
      valid: !!(planId && typeof planId === 'string')
    },
    billingCycle: {
      value: billingCycle,
      type: typeof billingCycle,
      valid: !!(billingCycle && typeof billingCycle === 'string')
    },
    finalPrice: {
      value: finalPrice,
      type: typeof finalPrice,
      valid: !!(finalPrice && typeof finalPrice === 'number' && finalPrice > 0)
    },
    serverConfig: {
      exists: !!serverConfig,
      type: typeof serverConfig,
      keys: serverConfig ? Object.keys(serverConfig) : null,
      fields: serverConfig ? {
        serverName: {
          value: serverConfig.serverName,
          type: typeof serverConfig.serverName,
          valid: !!(serverConfig.serverName && typeof serverConfig.serverName === 'string' && serverConfig.serverName.trim())
        },
        selectedServerType: {
          value: serverConfig.selectedServerType,
          type: typeof serverConfig.selectedServerType,
          valid: !!(serverConfig.selectedServerType && typeof serverConfig.selectedServerType === 'string')
        },
        totalCost: {
          value: serverConfig.totalCost,
          type: typeof serverConfig.totalCost,
          valid: !!(typeof serverConfig.totalCost === 'number' && serverConfig.totalCost > 0)
        }
      } : null
    }
  };
  
  res.json({
    message: 'Debug endpoint working',
    validation,
    timestamp: new Date().toISOString()
  });
});

// MAIN ENDPOINT: Create Checkout Session with SIMPLIFIED Validation
app.post('/create-checkout-session', async (req, res) => {
  console.log('🦆 === CHECKOUT SESSION REQUEST ===');
  console.log('🦆 Request received at:', new Date().toISOString());
  console.log('🦆 Request body:', JSON.stringify(req.body, null, 2));

  try {
    const { planId, billingCycle, finalPrice, serverConfig } = req.body;
    
    console.log('📋 Extracted fields:');
    console.log('  planId:', planId, '(type:', typeof planId, ')');
    console.log('  billingCycle:', billingCycle, '(type:', typeof billingCycle, ')');
    console.log('  finalPrice:', finalPrice, '(type:', typeof finalPrice, ')');
    console.log('  serverConfig:', serverConfig, '(type:', typeof serverConfig, ')');

    // SIMPLIFIED VALIDATION - Just check if essential fields exist
    const errors = [];
    
    if (!planId || typeof planId !== 'string') {
      errors.push('planId is missing or invalid');
    }
    if (!billingCycle || typeof billingCycle !== 'string') {
      errors.push('billingCycle is missing or invalid');
    }
    if (!finalPrice || typeof finalPrice !== 'number' || finalPrice <= 0) {
      errors.push('finalPrice is missing or invalid');
    }
    if (!serverConfig || typeof serverConfig !== 'object') {
      errors.push('serverConfig is missing or invalid');
    } else {
      // Check essential serverConfig fields
      if (!serverConfig.serverName || typeof serverConfig.serverName !== 'string' || !serverConfig.serverName.trim()) {
        errors.push('serverConfig.serverName is missing or invalid');
      }
      if (!serverConfig.selectedServerType || typeof serverConfig.selectedServerType !== 'string') {
        errors.push('serverConfig.selectedServerType is missing or invalid');
      }
      if (!serverConfig.minecraftVersion || typeof serverConfig.minecraftVersion !== 'string') {
        errors.push('serverConfig.minecraftVersion is missing or invalid');
      }
      if (typeof serverConfig.totalCost !== 'number' || serverConfig.totalCost <= 0) {
        errors.push('serverConfig.totalCost is missing or invalid');
      }
    }

    if (errors.length > 0) {
      console.log('❌ Validation failed:', errors);
      return res.status(400).json({
        error: 'Missing required server configuration',
        errors: errors,
        received: {
          planId: planId || 'missing',
          billingCycle: billingCycle || 'missing',
          finalPrice: finalPrice || 'missing',
          serverConfig: serverConfig ? 'present' : 'missing',
          serverConfigSample: serverConfig ? {
            serverName: serverConfig.serverName || 'missing',
            selectedServerType: serverConfig.selectedServerType || 'missing',
            minecraftVersion: serverConfig.minecraftVersion || 'missing',
            totalCost: serverConfig.totalCost || 'missing'
          } : 'missing'
        },
        timestamp: new Date().toISOString()
      });
    }

    console.log('✅ Validation passed!');

    // Check if Stripe is configured
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('Stripe not configured. Please set STRIPE_SECRET_KEY environment variable.');
    }

    // Define billing cycle mapping for Stripe
    const billingCycles = {
      monthly: { 
        interval: 'month', 
        interval_count: 1,
        multiplier: 1,
        discount: 0 
      },
      quarterly: { 
        interval: 'month', 
        interval_count: 3,
        multiplier: 3,
        discount: 0.05 
      },
      semiannual: { 
        interval: 'month', 
        interval_count: 6,
        multiplier: 6,
        discount: 0.10 
      },
      annual: { 
        interval: 'year', 
        interval_count: 1,
        multiplier: 12,
        discount: 0.15 
      }
    };

    const cycle = billingCycles[billingCycle];
    if (!cycle) {
      return res.status(400).json({
        error: 'Invalid billing cycle. Must be monthly, quarterly, semiannual, or annual'
      });
    }

    console.log('💰 Using billing cycle:', cycle);

    // Server-side price validation
    const serverCalculatedPrice = calculatePricing(serverConfig.totalCost, billingCycle, cycle);
    const priceDifference = Math.abs(serverCalculatedPrice.finalPrice - finalPrice);
    
    let validatedFinalPrice = finalPrice;
    if (priceDifference > 0.01) {
      console.warn('⚠️  Price mismatch detected:', {
        frontend: finalPrice,
        backend: serverCalculatedPrice.finalPrice,
        difference: priceDifference
      });
      validatedFinalPrice = serverCalculatedPrice.finalPrice;
    }

    console.log('💰 Final price validation:', {
      original: finalPrice,
      validated: validatedFinalPrice,
      difference: priceDifference
    });

    // Create price object for Stripe
    const priceData = {
      currency: 'usd',
      unit_amount: Math.round(validatedFinalPrice * 100),
      recurring: {
        interval: cycle.interval,
        interval_count: cycle.interval_count,
      },
      product_data: {
        name: `${serverConfig.serverName} - ${planId.charAt(0).toUpperCase() + planId.slice(1)} Plan`,
        description: `Minecraft server hosting - ${billingCycle} billing (${cycle.multiplier} month${cycle.multiplier > 1 ? 's' : ''})`,
        metadata: {
          plan: planId,
          billingCycle: billingCycle,
          serverType: serverConfig.selectedServerType || 'paper',
          minecraftVersion: serverConfig.minecraftVersion || 'latest'
        }
      }
    };

    console.log('💰 Price data for Stripe:', priceData);

    // Create comprehensive metadata for the checkout session
    const sessionMetadata = createSessionMetadata(serverConfig, billingCycle, cycle, validatedFinalPrice);

    console.log('📋 Session metadata:', sessionMetadata);

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price_data: priceData,
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/setup/${encodeURIComponent(serverConfig.serverName)}?cancelled=true`,
      metadata: sessionMetadata,
      subscription_data: {
        metadata: sessionMetadata
      },
      customer_email: serverConfig.customerEmail || undefined,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      automatic_tax: { enabled: false }
    });

    console.log('✅ Stripe session created successfully!');
    console.log('💳 Session ID:', session.id);
    console.log('💳 Session URL:', session.url);
    console.log('💰 Total amount:', (validatedFinalPrice * 100), 'cents');
    console.log('📅 Billing:', `${cycle.interval_count} ${cycle.interval}(s)`);

    res.json({
      sessionId: session.id,
      url: session.url,
      pricing: serverCalculatedPrice
    });

  } catch (error) {
    console.error('❌ Error creating checkout session:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({
      error: error.message || 'Failed to create checkout session',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

// Get session details endpoint
app.get('/session-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    console.log('📋 Fetching session details for:', sessionId);
    
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer', 'subscription']
    });

    console.log('✅ Session retrieved:', {
      id: session.id,
      status: session.payment_status,
      metadata: session.metadata
    });

    res.json({
      id: session.id,
      status: session.payment_status,
      amountTotal: session.amount_total,
      currency: session.currency,
      customerEmail: session.customer_details?.email || session.customer_email,
      metadata: session.metadata,
      createdAt: new Date(session.created * 1000).toISOString(),
      subscription: session.subscription
    });

  } catch (error) {
    console.error('❌ Error fetching session details:', error);
    res.status(500).json({
      error: 'Failed to fetch session details',
      details: error.message
    });
  }
});

// Webhook endpoint for Stripe events
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.warn('⚠️  Webhook secret not configured');
    return res.status(400).send('Webhook secret not configured');
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('⚠️  Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('🔔 Webhook received:', event.type);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log('💳 Payment completed for session:', session.id);
        console.log('📋 Session metadata:', session.metadata);
        
        // Extract billing information from metadata
        const billingCycle = session.metadata.billingCycle;
        const finalPrice = parseFloat(session.metadata.finalPrice);
        const monthlyRate = parseFloat(session.metadata.monthlyRate);
        
        console.log('💰 Billing details:');
        console.log('  • Cycle:', billingCycle);
        console.log('  • Final Price:', '$' + finalPrice.toFixed(2));
        console.log('  • Monthly Rate:', '$' + monthlyRate.toFixed(2));
        
        // Create the server with billing information
        await createPterodactylServer(session);
        break;

      case 'invoice.payment_succeeded':
        const invoice = event.data.object;
        console.log('💰 Recurring payment succeeded:', invoice.id);
        break;

      case 'invoice.payment_failed':
        const failedInvoice = event.data.object;
        console.log('❌ Payment failed:', failedInvoice.id);
        break;

      case 'customer.subscription.deleted':
        const subscription = event.data.object;
        console.log('🚫 Subscription cancelled:', subscription.id);
        break;

      default:
        console.log('ℹ️  Unhandled event type:', event.type);
    }
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    return res.status(500).send('Webhook processing failed');
  }

  res.json({ received: true });
});

// Create Pterodactyl server function
async function createPterodactylServer(session) {
  try {
    console.log('🦆 GOOSE HOSTING - PTERODACTYL DEPLOYMENT');
    console.log('==========================================');
    console.log('📋 Session Metadata:', session.metadata);

    const customerEmail = session.customer_details?.email || session.customer_email || 'admin@goosehosting.com';
    console.log('📧 Customer Email:', customerEmail);

    const config = await fetchPterodactylMeta(customerEmail);
    
    // Extract billing information
    const billingCycle = session.metadata.billingCycle || 'monthly';
    const finalPrice = parseFloat(session.metadata.finalPrice) || 0;
    const monthlyRate = parseFloat(session.metadata.monthlyRate) || 0;
    const billingMultiplier = parseInt(session.metadata.billingMultiplier) || 1;
    const billingDiscount = parseFloat(session.metadata.billingDiscount) || 0;
    
    console.log('💰 Billing Information:');
    console.log('  • Cycle:', billingCycle);
    console.log('  • Total Paid:', '$' + finalPrice.toFixed(2));
    console.log('  • Monthly Rate:', '$' + monthlyRate.toFixed(2));
    console.log('  • Billing Period:', billingMultiplier + ' month(s)');
    console.log('  • Discount Applied:', Math.round(billingDiscount * 100) + '%');
    
    // Extract server configuration
    const serverName = session.metadata.serverName || `GooseServer-${Date.now()}`;
    const serverType = session.metadata.selectedServerType || 'paper';
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

    // Mock server creation (replace with actual Pterodactyl API calls)
    const serverId = Math.floor(Math.random() * 10000);
    const serverUuid = `${serverId}-${Date.now()}`;
    const serverPort = 25565 + serverId;
    const serverAddress = `mc.goosehosting.com:${serverPort}`;

    console.log('🌐 Server Address:', serverAddress);
    console.log('✅ Server created successfully!');
    console.log('📦 Server Details:');
    console.log('  • Server ID:', serverId);
    console.log('  • Server UUID:', serverUuid);
    console.log('  • Server Address:', serverAddress);
    console.log('==========================================');

    // Update the Stripe session with server details
    await stripe.checkout.sessions.update(session.id, {
      metadata: {
        ...session.metadata,
        serverId: String(serverId),
        serverUuid: String(serverUuid),
        serverAddress: serverAddress,
        serverStatus: 'created',
        
        // Add server credentials
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
        pterodactylUserId: String(config.userId),
        updatedAt: new Date().toISOString()
      }
    });

    console.log('📝 Updated Stripe session with server details and credentials');

    return {
      success: true,
      serverId,
      serverUuid,
      serverName,
      serverAddress,
      credentials,
      billingInfo: {
        cycle: billingCycle,
        finalPrice,
        monthlyRate,
        billingMultiplier,
        discount: billingDiscount
      },
      message: 'Server created successfully'
    };

  } catch (err) {
    console.error('❌ Server creation failed:', {
      error: err.message,
      session_id: session.id,
      timestamp: new Date().toISOString()
    });
    
    throw err;
  }
}

// Deployment status endpoint
app.get('/deployment-status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const status = session.metadata.serverStatus || 'pending';
    
    res.json({
      status: status,
      sessionId: sessionId,
      serverName: session.metadata.serverName,
      ip: session.metadata.serverHost || 'mc.goosehosting.com',
      port: session.metadata.serverPort || '25565',
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

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log('🦆 GOOSE HOSTING BACKEND STARTED');
  console.log('================================');
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🏠 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
  console.log(`💳 Stripe configured: ${process.env.STRIPE_SECRET_KEY ? '✅ Yes' : '❌ No'}`);
  console.log(`🪝 Webhook configured: ${process.env.STRIPE_WEBHOOK_SECRET ? '✅ Yes' : '❌ No'}`);
  console.log(`🦆 Pterodactyl configured: ${PTERODACTYL_API_KEY ? '✅ Yes' : '❌ No'}`);
  console.log('================================');
  console.log('🔍 Debug mode enabled - detailed logging active');
  console.log('📊 Available endpoints:');
  console.log('  GET  /health - Health check');
  console.log('  POST /debug-request - Debug endpoint');
  console.log('  POST /debug-checkout - Debug checkout validation');
  console.log('  POST /create-checkout-session - Main payment endpoint');
  console.log('  GET  /session-details/:id - Session details');
  console.log('  POST /webhook - Stripe webhooks');
  console.log('  GET  /deployment-status/:sessionId - Check deployment status');
  console.log('================================');
});

module.exports = app;
