import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export class IamSecurityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get table ARNs from SSM
    const apiKeysTableArn = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/tables/api-keys/arn'
    );
    const auditLogsTableArn = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/tables/audit-logs/arn'
    );
    const taxDataTableArn = ssm.StringParameter.valueForStringParameter(
      this, '/getcomplical/tables/tax-data/arn'
    );

    // Create a restricted policy for developers
    const developerPolicy = new iam.ManagedPolicy(this, 'DeveloperRestrictedPolicy', {
      managedPolicyName: 'GetComplicalDeveloperPolicy',
      description: 'Restricted policy for developers - no direct API key table access',
      statements: [
        // Allow read-only access to tax data table
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'dynamodb:GetItem',
            'dynamodb:Query',
            'dynamodb:Scan',
            'dynamodb:DescribeTable',
          ],
          resources: [taxDataTableArn],
        }),
        // Allow read-only access to audit logs
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'dynamodb:GetItem',
            'dynamodb:Query',
            'dynamodb:DescribeTable',
          ],
          resources: [auditLogsTableArn],
        }),
        // Explicitly DENY direct access to API keys table
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ['dynamodb:*'],
          resources: [apiKeysTableArn],
        }),
        // Allow invoking dashboard functions for key management
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'lambda:InvokeFunction',
          ],
          resources: [
            `arn:aws:lambda:${this.region}:${this.account}:function:*Dashboard*`,
          ],
        }),
        // Allow API Gateway access
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'execute-api:Invoke',
          ],
          resources: [
            `arn:aws:execute-api:${this.region}:${this.account}:*/*/dashboard/*`,
          ],
        }),
      ],
    });

    // Create an admin policy with full access but audit requirements
    const adminPolicy = new iam.ManagedPolicy(this, 'AdminAuditedPolicy', {
      managedPolicyName: 'GetComplicalAdminPolicy',
      description: 'Admin policy with audit requirements',
      statements: [
        // Allow full DynamoDB access
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['dynamodb:*'],
          resources: ['*'],
          conditions: {
            StringEquals: {
              'aws:RequestedRegion': this.region,
            },
          },
        }),
        // Require MFA for sensitive operations
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: [
            'dynamodb:DeleteTable',
            'dynamodb:DeleteItem',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
          ],
          resources: [apiKeysTableArn],
          conditions: {
            BoolIfExists: {
              'aws:MultiFactorAuthPresent': 'false',
            },
          },
        }),
      ],
    });

    // Create a CI/CD policy for automated deployments
    const cicdPolicy = new iam.ManagedPolicy(this, 'CICDPolicy', {
      managedPolicyName: 'GetComplicalCICDPolicy',
      description: 'Policy for CI/CD pipelines',
      statements: [
        // Allow CloudFormation operations
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'cloudformation:*',
            'lambda:*',
            'apigateway:*',
            'dynamodb:Describe*',
            'dynamodb:List*',
            'iam:PassRole',
          ],
          resources: ['*'],
        }),
        // Deny direct modification of API keys
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: [
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:DeleteItem',
          ],
          resources: [apiKeysTableArn],
        }),
      ],
    });

    // Create a developer group
    const developerGroup = new iam.Group(this, 'DeveloperGroup', {
      groupName: 'GetComplicalDevelopers',
      managedPolicies: [developerPolicy],
    });

    // Create an admin group
    const adminGroup = new iam.Group(this, 'AdminGroup', {
      groupName: 'GetComplicalAdmins',
      managedPolicies: [adminPolicy],
    });

    // Output the policy ARNs
    new cdk.CfnOutput(this, 'DeveloperPolicyArn', {
      value: developerPolicy.managedPolicyArn,
      description: 'ARN of the developer restricted policy',
    });

    new cdk.CfnOutput(this, 'AdminPolicyArn', {
      value: adminPolicy.managedPolicyArn,
      description: 'ARN of the admin policy',
    });

    new cdk.CfnOutput(this, 'CICDPolicyArn', {
      value: cicdPolicy.managedPolicyArn,
      description: 'ARN of the CI/CD policy',
    });
  }
}