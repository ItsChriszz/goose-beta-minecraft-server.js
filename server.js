// server.js - Updated sections for billing cycles and server credentials

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

// Add this function to generate server credentials (your existing function)
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

// Updated function to generate random password
function generateRandomPassword(length = 16) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return password;
}

// NEW: Updated create-checkout-session endpoint with billing cycle support
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { 
      planId, 
      billingCycle, 
      finalPrice, 
      serverConfig 
    } = req.body;

    console.log('🦆 Creating checkout session with billing cycle:', {
      planId,
      billingCycle,
      finalPrice,
      serverConfig
    });

    // Validate required fields
    if (!planId || !billingCycle || !finalPrice || !serverConfig) {
      return res.status(400).json({
        error: 'Missing required fields: planId, billingCycle, finalPrice, or serverConfig'
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

    // Create price object for Stripe (this will be used once, then discarded)
    const priceData = {
      currency: 'usd',
      unit_amount: Math.round(finalPrice * 100), // Convert to cents
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
          serverType: serverConfig.serverType || 'paper',
          minecraftVersion: serverConfig.minecraftVersion || 'latest'
        }
      }
    };

    console.log('💰 Price data for Stripe:', priceData);

    // Create comprehensive metadata for the checkout session
    const sessionMetadata = {
      // Plan and billing info
      planId: planId,
      billingCycle: billingCycle,
      finalPrice: finalPrice.toString(),
      monthlyRate: serverConfig.totalCost.toString(),
      billingMultiplier: cycle.multiplier.toString(),
      billingDiscount: cycle.discount.toString(),
      
      // Server configuration
      serverName: serverConfig.serverName,
      serverType: serverConfig.serverType || 'paper',
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

    console.log('📋 Session metadata:', sessionMetadata);

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription', // Important: this is a subscription
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
        metadata: sessionMetadata // Also add to subscription metadata
      },
      customer_email: serverConfig.customerEmail, // If you collect email
      allow_promotion_codes: true, // Allow discount codes
      billing_address_collection: 'auto',
      automatic_tax: { enabled: false } // Set to true if you handle tax
    });

    console.log('✅ Stripe session created:', session.id);
    console.log('💳 Session URL:', session.url);
    console.log('💰 Total amount:', (finalPrice * 100), 'cents');
    console.log('📅 Billing:', `${cycle.interval_count} ${cycle.interval}(s)`);

    res.json({
      sessionId: session.id,
      url: session.url
    });

  } catch (error) {
    console.error('❌ Error creating checkout session:', error);
    res.status(500).json({
      error: error.message || 'Failed to create checkout session'
    });
  }
});

// Updated webhook handler to process billing cycle information
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

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

// Updated createPterodactylServer function with billing cycle awareness
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
    console.log('  • User ID:', config.userId);
    console.log('  • Allocation ID:', allocation.attributes.id);
    console.log('  • Egg ID:', config.eggId);
    console.log('  • Docker Image:', config.dockerImage);
    console.log('==========================================');

    // Update the Stripe session with ALL server details including credentials AND billing info
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
        pterodactylUserId: String(config.userId),
        createdAt: new Date().toISOString(),
        
        // Billing information is already in metadata, but we can confirm it's there
        amountPaid: finalPrice.toFixed(2),
        billingPeriodEnd: new Date(Date.now() + (billingMultiplier * 30 * 24 * 60 * 60 * 1000)).toISOString()
      }
    });

    console.log('📝 Updated Stripe session with complete server details including credentials and billing info');

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
      billingInfo: {
        cycle: billingCycle,
        finalPrice,
        monthlyRate,
        billingMultiplier,
        discount: billingDiscount
      },
      message: 'Server created successfully with credentials and billing information'
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
  }
}
