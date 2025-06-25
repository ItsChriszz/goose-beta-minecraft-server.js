// paymentHandler.js - Complete payment logic for backend
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

class PaymentHandler {
  constructor() {
    this.billingCycles = {
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
  }

  // Validate billing cycle
  validateBillingCycle(billingCycle) {
    return this.billingCycles.hasOwnProperty(billingCycle);
  }

  // Get billing cycle configuration
  getBillingCycle(billingCycle) {
    return this.billingCycles[billingCycle];
  }

  // Calculate pricing (server-side validation)
  calculatePricing(monthlyPrice, billingCycle) {
    const cycle = this.getBillingCycle(billingCycle);
    if (!cycle) {
      throw new Error('Invalid billing cycle');
    }

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

  // ADDED: Simple validation for server configuration
  validateServerConfig(serverConfig) {
    const errors = [];

    if (!serverConfig) {
      errors.push('Server configuration is missing');
      return { isValid: false, errors };
    }

    // Check required string fields
    const requiredStringFields = ['serverName', 'planId', 'selectedServerType', 'minecraftVersion'];
    requiredStringFields.forEach(field => {
      if (!serverConfig[field] || typeof serverConfig[field] !== 'string' || !serverConfig[field].trim()) {
        errors.push(`${field} is required and must be a non-empty string`);
      }
    });

    // Check required number fields
    const requiredNumberFields = ['totalCost', 'totalRam', 'maxPlayers', 'viewDistance'];
    requiredNumberFields.forEach(field => {
      if (typeof serverConfig[field] !== 'number' || serverConfig[field] <= 0) {
        errors.push(`${field} is required and must be a positive number`);
      }
    });

    // Check boolean fields (optional but should be boolean if present)
    const booleanFields = ['enableWhitelist', 'enablePvp'];
    booleanFields.forEach(field => {
      if (serverConfig[field] !== undefined && typeof serverConfig[field] !== 'boolean') {
        errors.push(`${field} must be a boolean if provided`);
      }
    });

    // Check array fields (optional but should be array if present)
    if (serverConfig.selectedPlugins !== undefined && !Array.isArray(serverConfig.selectedPlugins)) {
      errors.push('selectedPlugins must be an array if provided');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  // Create Stripe checkout session
  async createCheckoutSession(requestData) {
    const { 
      planId, 
      billingCycle, 
      finalPrice, 
      serverConfig 
    } = requestData;

    console.log('🦆 PaymentHandler - Creating checkout session:', {
      planId,
      billingCycle,
      finalPrice,
      serverName: serverConfig?.serverName
    });

    // Validate required fields
    if (!planId || !billingCycle || !finalPrice || !serverConfig) {
      throw new Error('Missing required fields: planId, billingCycle, finalPrice, or serverConfig');
    }

    // Validate billing cycle
    if (!this.validateBillingCycle(billingCycle)) {
      throw new Error('Invalid billing cycle. Must be monthly, quarterly, semiannual, or annual');
    }

    // Validate server configuration
    const validation = this.validateServerConfig(serverConfig);
    if (!validation.isValid) {
      throw new Error(`Configuration errors: ${validation.errors.join(', ')}`);
    }

    const cycle = this.getBillingCycle(billingCycle);

    // Server-side price validation (important for security)
    const serverCalculatedPrice = this.calculatePricing(serverConfig.totalCost, billingCycle);
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
    const sessionMetadata = this.createSessionMetadata(serverConfig, billingCycle, cycle, validatedFinalPrice);

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

    console.log('✅ Stripe session created:', session.id);
    console.log('💳 Session URL:', session.url);
    console.log('💰 Total amount:', (validatedFinalPrice * 100), 'cents');
    console.log('📅 Billing:', `${cycle.interval_count} ${cycle.interval}(s)`);

    return {
      sessionId: session.id,
      url: session.url,
      pricing: serverCalculatedPrice
    };
  }

  // Create session metadata
  createSessionMetadata(serverConfig, billingCycle, cycle, finalPrice) {
    return {
      // Plan and billing info
      planId: planId,
      billingCycle: billingCycle,
      finalPrice: finalPrice.toString(),
      monthlyRate: serverConfig.totalCost.toString(),
      billingMultiplier: cycle.multiplier.toString(),
      billingDiscount: cycle.discount.toString(),
      
      // Server configuration
      serverName: serverConfig.serverName,
      selectedServerType: serverConfig.selectedServerType || 'paper', // FIXED: Use selectedServerType
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

  // Validate webhook signature
  validateWebhook(body, signature, webhookSecret) {
    try {
      return stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } catch (err) {
      throw new Error(`Webhook signature verification failed: ${err.message}`);
    }
  }

  // Process webhook events
  async processWebhookEvent(event) {
    console.log('🔔 Processing webhook event:', event.type);

    switch (event.type) {
      case 'checkout.session.completed':
        return await this.handleCheckoutCompleted(event.data.object);

      case 'invoice.payment_succeeded':
        return await this.handlePaymentSucceeded(event.data.object);

      case 'invoice.payment_failed':
        return await this.handlePaymentFailed(event.data.object);

      case 'customer.subscription.deleted':
        return await this.handleSubscriptionCancelled(event.data.object);

      default:
        console.log('ℹ️  Unhandled event type:', event.type);
        return { processed: false, reason: 'Unhandled event type' };
    }
  }

  // Handle successful checkout
  async handleCheckoutCompleted(session) {
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
    
    return {
      processed: true,
      action: 'server_creation',
      session: session
    };
  }

  // Handle recurring payment success
  async handlePaymentSucceeded(invoice) {
    console.log('💰 Recurring payment succeeded:', invoice.id);
    
    return {
      processed: true,
      action: 'payment_succeeded',
      invoice: invoice
    };
  }

  // Handle payment failure
  async handlePaymentFailed(invoice) {
    console.log('❌ Payment failed:', invoice.id);
    
    return {
      processed: true,
      action: 'payment_failed',
      invoice: invoice
    };
  }

  // Handle subscription cancellation
  async handleSubscriptionCancelled(subscription) {
    console.log('🚫 Subscription cancelled:', subscription.id);
    
    return {
      processed: true,
      action: 'subscription_cancelled',
      subscription: subscription
    };
  }

  // Format price for logging
  formatPrice(amount, currency = 'USD') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  }

  // Update session with server details
  async updateSessionWithServerDetails(sessionId, serverDetails) {
    try {
      const updatedSession = await stripe.checkout.sessions.update(sessionId, {
        metadata: {
          ...serverDetails.metadata,
          serverId: String(serverDetails.serverId),
          serverUuid: String(serverDetails.serverUuid),
          serverAddress: serverDetails.serverAddress,
          serverStatus: 'created',
          
          // Add server credentials and connection info
          serverUsername: serverDetails.credentials.username,
          serverPassword: serverDetails.credentials.password,
          panelUrl: `https://panel.goosehosting.com/server/${serverDetails.serverUuid}`,
          ftpHost: 'ftp.goosehosting.com',
          ftpPort: '21',
          ftpUsername: serverDetails.credentials.username,
          ftpPassword: serverDetails.credentials.password,
          
          // Additional server info
          serverPort: String(serverDetails.serverPort),
          serverHost: 'mc.goosehosting.com',
          pterodactylUserId: String(serverDetails.userId),
          updatedAt: new Date().toISOString()
        }
      });

      console.log('📝 Updated Stripe session with server details');
      return updatedSession;
    } catch (error) {
      console.error('❌ Failed to update Stripe session:', error);
      throw error;
    }
  }
}

module.exports = PaymentHandler;
