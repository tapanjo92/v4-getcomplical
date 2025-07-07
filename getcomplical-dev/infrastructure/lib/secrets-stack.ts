import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
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
    
    // Export to SSM Parameters for decoupled access
    new ssm.StringParameter(this, 'HealthCheckKeySecretNameParam', {
      parameterName: '/getcomplical/secrets/health-check-key/name',
      stringValue: this.healthCheckKeySecret.secretName,
      description: 'Name of the health check key secret',
    });

    new ssm.StringParameter(this, 'HealthCheckKeySecretArnParam', {
      parameterName: '/getcomplical/secrets/health-check-key/arn',
      stringValue: this.healthCheckKeySecret.secretArn,
      description: 'ARN of the health check key secret',
    });

    new ssm.StringParameter(this, 'ApiConfigSecretNameParam', {
      parameterName: '/getcomplical/secrets/api-config/name',
      stringValue: this.apiConfigSecret.secretName,
      description: 'Name of the API config secret',
    });

    new ssm.StringParameter(this, 'ApiConfigSecretArnParam', {
      parameterName: '/getcomplical/secrets/api-config/arn',
      stringValue: this.apiConfigSecret.secretArn,
      description: 'ARN of the API config secret',
    });

    new ssm.StringParameter(this, 'StripeWebhookSecretNameParam', {
      parameterName: '/getcomplical/secrets/stripe-webhook/name',
      stringValue: this.stripeWebhookSecret.secretName,
      description: 'Name of the Stripe webhook secret',
    });

    new ssm.StringParameter(this, 'StripeWebhookSecretArnParam', {
      parameterName: '/getcomplical/secrets/stripe-webhook/arn',
      stringValue: this.stripeWebhookSecret.secretArn,
      description: 'ARN of the Stripe webhook secret',
    });

    new ssm.StringParameter(this, 'PaddleWebhookSecretNameParam', {
      parameterName: '/getcomplical/secrets/paddle-webhook/name',
      stringValue: this.paddleWebhookSecret.secretName,
      description: 'Name of the Paddle webhook secret',
    });

    new ssm.StringParameter(this, 'PaddleWebhookSecretArnParam', {
      parameterName: '/getcomplical/secrets/paddle-webhook/arn',
      stringValue: this.paddleWebhookSecret.secretArn,
      description: 'ARN of the Paddle webhook secret',
    });

    // Keep outputs for visibility but remove exports
    new cdk.CfnOutput(this, 'HealthCheckKeySecretArn', {
      value: this.healthCheckKeySecret.secretArn,
      description: 'ARN of the health check key secret',
    });
    
    new cdk.CfnOutput(this, 'ApiConfigSecretArn', {
      value: this.apiConfigSecret.secretArn,
      description: 'ARN of the API configuration secret',
    });
    
    new cdk.CfnOutput(this, 'StripeWebhookSecretArn', {
      value: this.stripeWebhookSecret.secretArn,
      description: 'ARN of the Stripe webhook secret',
    });
    
    new cdk.CfnOutput(this, 'PaddleWebhookSecretArn', {
      value: this.paddleWebhookSecret.secretArn,
      description: 'ARN of the Paddle webhook secret',
    });

    // CloudFront secret for API Gateway validation
    const cloudfrontSecret = new secretsmanager.Secret(this, 'CloudFrontSecret', {
      secretName: 'getcomplical/cloudfront-api-secret',
      description: 'Secret header value for CloudFront to API Gateway authentication',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'headerValue',
        passwordLength: 32,
        excludeCharacters: ' "\'\\',
      },
    });

    // Export CloudFront secret to SSM
    new ssm.StringParameter(this, 'CloudFrontSecretNameParam', {
      parameterName: '/getcomplical/secrets/cloudfront-api/name',
      stringValue: cloudfrontSecret.secretName,
      description: 'Name of the CloudFront API secret',
    });

    new ssm.StringParameter(this, 'CloudFrontSecretArnParam', {
      parameterName: '/getcomplical/secrets/cloudfront-api/arn',
      stringValue: cloudfrontSecret.secretArn,
      description: 'ARN of the CloudFront API secret',
    });

    // Valkey auth token for encryption
    const valkeyAuthToken = new secretsmanager.Secret(this, 'ValkeyAuthToken', {
      secretName: 'getcomplical/valkey-auth-token',
      description: 'Authentication token for Valkey cluster encryption',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'authToken',
        passwordLength: 64,
        excludeCharacters: ' "\'\\@',
      },
    });

    // Export Valkey auth token to SSM
    new ssm.StringParameter(this, 'ValkeyAuthTokenNameParam', {
      parameterName: '/getcomplical/secrets/valkey-auth/name',
      stringValue: valkeyAuthToken.secretName,
      description: 'Name of the Valkey auth token secret',
    });

    new ssm.StringParameter(this, 'ValkeyAuthTokenArnParam', {
      parameterName: '/getcomplical/secrets/valkey-auth/arn',
      stringValue: valkeyAuthToken.secretArn,
      description: 'ARN of Valkey auth token secret',
    });

    // Keep output for visibility
    new cdk.CfnOutput(this, 'ValkeyAuthTokenArn', {
      value: valkeyAuthToken.secretArn,
      description: 'ARN of Valkey auth token secret',
    });
  }
}