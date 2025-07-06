import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class SecretsStack extends cdk.Stack {
  public readonly healthCheckKeySecret: secretsmanager.Secret;
  public readonly apiConfigSecret: secretsmanager.Secret;
  public readonly stripeWebhookSecret: secretsmanager.Secret;
  public readonly paddleWebhookSecret: secretsmanager.Secret;
  
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    
    // Create health check key secret
    this.healthCheckKeySecret = new secretsmanager.Secret(this, 'HealthCheckKeySecret', {
      secretName: 'getcomplical/health-check-key',
      description: 'Secret key for authenticating internal health check requests',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'key',
        excludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/@"\\',
        passwordLength: 32,
      },
    });
    
    // Create API configuration secret for future use
    this.apiConfigSecret = new secretsmanager.Secret(this, 'ApiConfigSecret', {
      secretName: 'getcomplical/api-config',
      description: 'API configuration including third-party integrations',
      secretObjectValue: {
        apiKeyPrefix: cdk.SecretValue.unsafePlainText('gc_live_'),
        dashboardDomain: cdk.SecretValue.unsafePlainText('https://api.getcomplical.com'),
        supportEmail: cdk.SecretValue.unsafePlainText('support@getcomplical.com'),
        // Placeholder for future third-party API keys
        stripeApiKey: cdk.SecretValue.unsafePlainText('placeholder'),
        sendgridApiKey: cdk.SecretValue.unsafePlainText('placeholder'),
        slackWebhookUrl: cdk.SecretValue.unsafePlainText('placeholder'),
      },
    });
    
    // Create rotation Lambda role (for future implementation)
    const rotationRole = new iam.Role(this, 'SecretRotationRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    
    // Grant rotation permissions
    this.healthCheckKeySecret.grantRead(rotationRole);
    this.healthCheckKeySecret.grantWrite(rotationRole);
    
    // Create billing webhook secrets
    this.stripeWebhookSecret = new secretsmanager.Secret(this, 'StripeWebhookSecret', {
      secretName: 'getcomplical/stripe-webhook-secret',
      description: 'Stripe webhook endpoint secret for signature verification',
      secretObjectValue: {
        webhookSecret: cdk.SecretValue.unsafePlainText('whsec_placeholder_update_in_console'),
        apiKey: cdk.SecretValue.unsafePlainText('sk_test_placeholder'),
      },
    });
    
    this.paddleWebhookSecret = new secretsmanager.Secret(this, 'PaddleWebhookSecret', {
      secretName: 'getcomplical/paddle-webhook-secret',
      description: 'Paddle webhook verification secret',
      secretObjectValue: {
        webhookSecret: cdk.SecretValue.unsafePlainText('pdl_webhook_placeholder_update_in_console'),
        apiKey: cdk.SecretValue.unsafePlainText('pdl_test_placeholder'),
      },
    });
    
    // Outputs
    new cdk.CfnOutput(this, 'HealthCheckKeySecretArn', {
      value: this.healthCheckKeySecret.secretArn,
      description: 'ARN of the health check key secret',
      exportName: 'GetComplicalHealthCheckKeySecretArn',
    });
    
    new cdk.CfnOutput(this, 'ApiConfigSecretArn', {
      value: this.apiConfigSecret.secretArn,
      description: 'ARN of the API configuration secret',
      exportName: 'GetComplicalApiConfigSecretArn',
    });
    
    new cdk.CfnOutput(this, 'StripeWebhookSecretArn', {
      value: this.stripeWebhookSecret.secretArn,
      description: 'ARN of the Stripe webhook secret',
    });
    
    new cdk.CfnOutput(this, 'PaddleWebhookSecretArn', {
      value: this.paddleWebhookSecret.secretArn,
      description: 'ARN of the Paddle webhook secret',
    });
  }
}