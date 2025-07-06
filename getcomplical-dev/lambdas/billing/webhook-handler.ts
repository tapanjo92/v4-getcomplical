import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import * as crypto from 'crypto';

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const snsClient = new SNSClient({ region: process.env.AWS_REGION });
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });

const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;
const BILLING_EVENTS_TOPIC_ARN = process.env.BILLING_EVENTS_TOPIC_ARN!;

let cachedStripeSecret: string | null = null;
let cachedPaddleSecret: string | null = null;

interface StripeEvent {
  id: string;
  object: string;
  type: string;
  created: number;
  data: {
    object: any;
    previous_attributes?: any;
  };
}

interface PaddleEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: any;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Webhook received', {
    path: event.path,
    headers: event.headers,
  });
  
  const headers = {
    'Content-Type': 'application/json',
  };
  
  try {
    if (event.path.endsWith('/stripe')) {
      return await handleStripeWebhook(event);
    } else if (event.path.endsWith('/paddle')) {
      return await handlePaddleWebhook(event);
    }
    
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Webhook endpoint not found' }),
    };
  } catch (error) {
    console.error('Webhook processing error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

async function handleStripeWebhook(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // Verify webhook signature
  const signature = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!signature || !event.body) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing signature or body' }),
    };
  }
  
  const webhookSecret = await getStripeWebhookSecret();
  
  // Verify signature
  try {
    const timestamp = signature.split(',')[0].split('=')[1];
    const signatures = signature.split(' ').filter(s => s.startsWith('v1=')).map(s => s.split('=')[1]);
    
    const payload = `${timestamp}.${event.body}`;
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(payload)
      .digest('hex');
    
    const validSignature = signatures.some(sig => 
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSignature))
    );
    
    if (!validSignature) {
      console.error('Invalid Stripe signature');
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid signature' }),
      };
    }
  } catch (error) {
    console.error('Signature verification failed:', error);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid signature' }),
    };
  }
  
  const stripeEvent: StripeEvent = JSON.parse(event.body);
  console.log('Processing Stripe event:', stripeEvent.type);
  
  switch (stripeEvent.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(stripeEvent.data.object);
      break;
      
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await handleSubscriptionChange(stripeEvent.data.object);
      break;
      
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(stripeEvent.data.object);
      break;
      
    case 'invoice.payment_succeeded':
      await handlePaymentSucceeded(stripeEvent.data.object);
      break;
      
    case 'invoice.payment_failed':
      await handlePaymentFailed(stripeEvent.data.object);
      break;
      
    default:
      console.log('Unhandled Stripe event type:', stripeEvent.type);
  }
  
  // Publish event to SNS for further processing
  await publishBillingEvent('stripe', stripeEvent);
  
  return {
    statusCode: 200,
    body: JSON.stringify({ received: true }),
  };
}

async function handlePaddleWebhook(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // Paddle webhook verification
  const signature = event.headers['paddle-signature'] || event.headers['Paddle-Signature'];
  if (!signature || !event.body) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing signature or body' }),
    };
  }
  
  const webhookSecret = await getPaddleWebhookSecret();
  
  // Verify Paddle signature (Paddle uses a different format)
  // This is a simplified version - implement full Paddle signature verification
  const paddleEvent: PaddleEvent = JSON.parse(event.body);
  console.log('Processing Paddle event:', paddleEvent.event_type);
  
  switch (paddleEvent.event_type) {
    case 'subscription.created':
    case 'subscription.updated':
      await handlePaddleSubscriptionChange(paddleEvent.data);
      break;
      
    case 'subscription.cancelled':
      await handlePaddleSubscriptionCancelled(paddleEvent.data);
      break;
      
    case 'transaction.completed':
      await handlePaddleTransactionCompleted(paddleEvent.data);
      break;
      
    default:
      console.log('Unhandled Paddle event type:', paddleEvent.event_type);
  }
  
  // Publish event to SNS
  await publishBillingEvent('paddle', paddleEvent);
  
  return {
    statusCode: 200,
    body: JSON.stringify({ received: true }),
  };
}

async function handleCheckoutCompleted(session: any) {
  const { customer, subscription, metadata } = session;
  const { api_key, user_id } = metadata || {};
  
  if (!api_key || !user_id) {
    console.error('Missing metadata in checkout session');
    return;
  }
  
  // Update API key with customer ID and subscription info
  await docClient.send(new UpdateCommand({
    TableName: API_KEYS_TABLE,
    Key: { apiKey: api_key },
    UpdateExpression: `
      SET customerId = :customerId,
          stripeCustomerId = :stripeCustomerId,
          stripeSubscriptionId = :subscriptionId,
          billingStatus = :status,
          updatedAt = :updatedAt
    `,
    ExpressionAttributeValues: {
      ':customerId': customer,
      ':stripeCustomerId': customer,
      ':subscriptionId': subscription,
      ':status': 'active',
      ':updatedAt': new Date().toISOString(),
    },
  }));
}

async function handleSubscriptionChange(subscription: any) {
  const { id, customer, status, current_period_end, items } = subscription;
  
  // Find API key by Stripe customer ID
  const apiKey = await findApiKeyByCustomerId(customer, 'stripe');
  if (!apiKey) {
    console.error('API key not found for customer:', customer);
    return;
  }
  
  // Map Stripe plan to our tier
  const planId = items.data[0]?.price?.id;
  const tier = mapStripePlanToTier(planId);
  
  await docClient.send(new UpdateCommand({
    TableName: API_KEYS_TABLE,
    Key: { apiKey },
    UpdateExpression: `
      SET tier = :tier,
          billingStatus = :status,
          subscriptionEndDate = :endDate,
          updatedAt = :updatedAt
    `,
    ExpressionAttributeValues: {
      ':tier': tier,
      ':status': status,
      ':endDate': new Date(current_period_end * 1000).toISOString(),
      ':updatedAt': new Date().toISOString(),
    },
  }));
}

async function handleSubscriptionDeleted(subscription: any) {
  const { customer } = subscription;
  
  const apiKey = await findApiKeyByCustomerId(customer, 'stripe');
  if (!apiKey) return;
  
  // Downgrade to free tier
  await docClient.send(new UpdateCommand({
    TableName: API_KEYS_TABLE,
    Key: { apiKey },
    UpdateExpression: `
      SET tier = :tier,
          billingStatus = :status,
          stripeSubscriptionId = :null,
          updatedAt = :updatedAt
    `,
    ExpressionAttributeValues: {
      ':tier': 'free',
      ':status': 'cancelled',
      ':null': null,
      ':updatedAt': new Date().toISOString(),
    },
  }));
}

async function handlePaymentSucceeded(invoice: any) {
  console.log('Payment succeeded for customer:', invoice.customer);
  // Could update usage quotas or send confirmation emails
}

async function handlePaymentFailed(invoice: any) {
  const { customer, attempt_count } = invoice;
  
  const apiKey = await findApiKeyByCustomerId(customer, 'stripe');
  if (!apiKey) return;
  
  // After 3 attempts, consider suspending the API key
  if (attempt_count >= 3) {
    await docClient.send(new UpdateCommand({
      TableName: API_KEYS_TABLE,
      Key: { apiKey },
      UpdateExpression: 'SET billingStatus = :status, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':status': 'payment_failed',
        ':updatedAt': new Date().toISOString(),
      },
    }));
  }
}

async function handlePaddleSubscriptionChange(subscription: any) {
  const { id, customer_id, status, items } = subscription;
  
  const apiKey = await findApiKeyByCustomerId(customer_id, 'paddle');
  if (!apiKey) return;
  
  const tier = mapPaddlePlanToTier(items[0]?.price?.id);
  
  await docClient.send(new UpdateCommand({
    TableName: API_KEYS_TABLE,
    Key: { apiKey },
    UpdateExpression: `
      SET tier = :tier,
          billingStatus = :status,
          paddleCustomerId = :customerId,
          paddleSubscriptionId = :subscriptionId,
          updatedAt = :updatedAt
    `,
    ExpressionAttributeValues: {
      ':tier': tier,
      ':status': status,
      ':customerId': customer_id,
      ':subscriptionId': id,
      ':updatedAt': new Date().toISOString(),
    },
  }));
}

async function handlePaddleSubscriptionCancelled(subscription: any) {
  const { customer_id } = subscription;
  
  const apiKey = await findApiKeyByCustomerId(customer_id, 'paddle');
  if (!apiKey) return;
  
  await docClient.send(new UpdateCommand({
    TableName: API_KEYS_TABLE,
    Key: { apiKey },
    UpdateExpression: `
      SET tier = :tier,
          billingStatus = :status,
          paddleSubscriptionId = :null,
          updatedAt = :updatedAt
    `,
    ExpressionAttributeValues: {
      ':tier': 'free',
      ':status': 'cancelled',
      ':null': null,
      ':updatedAt': new Date().toISOString(),
    },
  }));
}

async function handlePaddleTransactionCompleted(transaction: any) {
  console.log('Paddle transaction completed:', transaction.id);
  // Process successful payment
}

async function findApiKeyByCustomerId(customerId: string, provider: 'stripe' | 'paddle'): Promise<string | null> {
  // This would need a GSI on customerId or stripeCustomerId/paddleCustomerId
  // For now, we'll scan (not ideal for production)
  console.warn('Using scan to find API key - consider adding GSI');
  return null; // Implement proper lookup
}

async function publishBillingEvent(provider: string, event: any) {
  await snsClient.send(new PublishCommand({
    TopicArn: BILLING_EVENTS_TOPIC_ARN,
    Subject: `Billing Event - ${provider} - ${event.type || event.event_type}`,
    Message: JSON.stringify({
      provider,
      event,
      timestamp: new Date().toISOString(),
    }),
    MessageAttributes: {
      provider: { DataType: 'String', StringValue: provider },
      eventType: { DataType: 'String', StringValue: event.type || event.event_type },
    },
  }));
}

async function getStripeWebhookSecret(): Promise<string> {
  if (cachedStripeSecret) return cachedStripeSecret;
  
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: process.env.STRIPE_WEBHOOK_SECRET_ARN,
    }));
    
    if (response.SecretString) {
      const secret = JSON.parse(response.SecretString);
      cachedStripeSecret = secret.webhookSecret;
      return cachedStripeSecret;
    }
  } catch (error) {
    console.error('Failed to retrieve Stripe webhook secret:', error);
  }
  
  throw new Error('Stripe webhook secret not found');
}

async function getPaddleWebhookSecret(): Promise<string> {
  if (cachedPaddleSecret) return cachedPaddleSecret;
  
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: process.env.PADDLE_WEBHOOK_SECRET_ARN,
    }));
    
    if (response.SecretString) {
      const secret = JSON.parse(response.SecretString);
      cachedPaddleSecret = secret.webhookSecret;
      return cachedPaddleSecret;
    }
  } catch (error) {
    console.error('Failed to retrieve Paddle webhook secret:', error);
  }
  
  throw new Error('Paddle webhook secret not found');
}

function mapStripePlanToTier(planId: string): string {
  const planMap: Record<string, string> = {
    'price_starter': 'starter',
    'price_professional': 'professional',
    'price_enterprise': 'enterprise',
  };
  
  return planMap[planId] || 'free';
}

function mapPaddlePlanToTier(planId: string): string {
  const planMap: Record<string, string> = {
    'plan_starter': 'starter',
    'plan_professional': 'professional',
    'plan_enterprise': 'enterprise',
  };
  
  return planMap[planId] || 'free';
}