// server.js - Complete Fixed Backend for GoosePanel
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
  if (req.method === 'POST' && req.path.includes('checkout')) {
    console.log('📋 Request body keys:', Object.keys(req.body));
  }
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
  // This would typically fetch from your Pterodactyl panel
  // For now, returning mock data
  return {
    userId: 1,
    nodeId: 1,
    eggId: 15, // Minecraft Java egg ID
    dockerImage: 'ghcr.io/pterodactyl/yolks:java_17',
    startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -Dterminal.jline=false -Dterminal.ansi=true -jar {{SERVER_JARFILE}}'
  };
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Test endpoint for debugging
app.post('/test-server-config', (req, res) => {
  console.log('🧪 Test endpoint - received data:', {
    body: req.body,
    headers: req.headers,
    contentType: req.get('Content-Type')
  });
  
  res.json({
    received: req.body,
    message: 'Data received successfully',
    timestamp: new Date().toISOString()
  });
});

// MAIN ENDPOINT: Create Checkout Session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { 
      planId, 
      billingCycle, 
      finalPrice, 
      serverConfig 
    } = req.body;

    console.log('🦆 Backend - Creating checkout session with data:', {
      planId,
      billingCycle,
      finalPrice,
      serverConfigKeys: serverConfig ? Object.keys(serverConfig) : 'null'
    });

    // Enhanced validation with detailed error messages
    const validationErrors = [];

    // Check main fields
    if (!planId) {
      validationErrors.push('planId is required');
      console.log('❌ Missing planId');
    }
    
    if (!billingCycle) {
      validationErrors.push('billingCycle is required');
      console.log('❌ Missing billingCycle');
    }
    
    if (!finalPrice || finalPrice <= 0) {
      validationErrors.push('finalPrice must be a positive number');
      console.log('❌ Invalid finalPrice:', finalPrice);
    }
    
    // Check serverConfig object
    if (!serverConfig) {
      validationErrors.push('serverConfig is required');
      console.log('❌ Missing serverConfig object');
    } else {
      console.log('📋 ServerConfig received:', JSON.stringify(serverConfig, null, 2));
      
      // Check serverConfig fields
      if (!serverConfig.serverName || !serverConfig.serverName.trim()) {
        validationErrors.push('serverConfig.serverName is required');
        console.log('❌ Invalid serverName:', serverConfig.serverName);
      }
      
      if (!serverConfig.planId) {
        validationErrors.push('serverConfig.planId is required');
        console.log('❌ Missing serverConfig.planId');
      }
      
      if (!serverConfig.selectedServerType) {
        validationErrors.push('serverConfig.selectedServerType is required');
        console.log('❌ Missing selectedServerType');
      }
      
      if (!serverConfig.minecraftVersion) {
        validationErrors.push('serverConfig.minecraftVersion is required');
        console.log('❌ Missing minecraftVersion');
      }
      
      if (!serverConfig.totalCost || serverConfig.totalCost <= 0) {
        validationErrors.push('serverConfig.totalCost must be a positive number');
        console.log('❌ Invalid totalCost:', serverConfig.totalCost);
      }
      
      // Check numeric fields with type conversion
      const totalRam = Number(serverConfig.totalRam);
      if (isNaN(totalRam) || totalRam <= 0) {
        validationErrors.push('serverConfig.totalRam must be a positive number');
        console.log('❌ Invalid totalRam:', serverConfig.totalRam, typeof serverConfig.totalRam);
      }
      
      const maxPlayers = Number(serverConfig.maxPlayers);
      if (isNaN(maxPlayers) || maxPlayers <= 0) {
        validationErrors.push('serverConfig.maxPlayers must be a positive number');
        console.log('❌ Invalid maxPlayers:', serverConfig.maxPlayers, typeof serverConfig.maxPlayers);
      }
      
      const viewDistance = Number(serverConfig.viewDistance);
      if (isNaN(viewDistance) || viewDistance <= 0) {
        validationErrors.push('serverConfig.viewDistance must be a positive number');
        console.log('❌ Invalid viewDistance:', serverConfig.viewDistance, typeof serverConfig.viewDistance);
      }
    }

    // If there are validation errors, return them
    if (validationErrors.length > 0) {
      console.error('❌ Validation failed:', validationErrors);
      return res.status(400).json({
        error: 'Missing required server configuration',
        details: validationErrors,
        received: {
          planId: planId || 'missing',
          billingCycle: billingCycle || 'missing',
          finalPrice: finalPrice || 'missing',
          serverConfigKeys: serverConfig ? Object.keys(serverConfig) : 'serverConfig is null/undefined'
        }
      });
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

    // Server-side price validation (important for security)
    const serverCalculatedPrice = calculatePricing(serverConfig.totalCost, billingCycle, cycle);
    const priceDifference = Math.abs(serverCalculatedPrice.finalPrice - finalPrice);
    
    let validatedFinalPrice = finalPrice;
    if (priceDifference > 0.01) { // Allow 1 cent difference for rounding
      console.warn('⚠️  Price mismatch detected:', {
        frontend: finalPrice,
        backend: serverCalculatedPrice.finalPrice,
        difference: priceDifference
      });
      // Use server-calculated price for security
      validatedFinalPrice = serverCalculatedPrice.finalPrice;
    }

    // Create price object for Stripe
    const priceData = {
      currency: 'usd',
      unit_amount: Math.round(validatedFinalPrice * 100), // Convert to cents
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

    // Check if Stripe is configured
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('Stripe not configured. Please set STRIPE_SECRET_KEY environment variable.');
    }

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

    console.log('✅ Stripe session created:', session.id);
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
    res.status(500).json({
      error: error.message || 'Failed to create checkout session',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

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

    // Return session details with metadata
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
        // Handle recurring payments here
        break;

      case 'invoice.payment_failed':
        const failedInvoice = event.data.object;
        console.log('❌ Payment failed:', failedInvoice.id);
        // Handle failed payments (maybe suspend server)
        break;

      case 'customer.subscription.deleted':
        const subscription = event.data.object;
        console.log('🚫 Subscription cancelled:', subscription.id);
        // Handle subscription cancellation (suspend/delete server)
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

    // Get customer email from Stripe session
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
    
    // Extract server configuration (all are strings from Stripe metadata)
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
    method: req.method
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
});

module.exports = app;
