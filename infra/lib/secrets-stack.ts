import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface SecretEntries {
  webhook: secretsmanager.ISecret;
  datadog: secretsmanager.ISecret;
  github: secretsmanager.ISecret;
  slack: secretsmanager.ISecret;
  cursor: secretsmanager.ISecret;
  langfuse: secretsmanager.ISecret;
}

export class SecretsStack extends cdk.Stack {
  readonly entries: SecretEntries;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const placeholder = (name: string, template: Record<string, string>) =>
      new secretsmanager.Secret(this, name, {
        secretName: `opssage/${name.toLowerCase()}`,
        description: `OpsSage ${name}`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify(template),
          generateStringKey: 'placeholder',
          excludePunctuation: true,
        },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

    this.entries = {
      webhook: placeholder('webhook', { datadog_shared_secret: '' }),
      datadog: placeholder('datadog', { api_key: '', app_key: '', site: 'datadoghq.com' }),
      github: placeholder('github', { pat: '' }),
      slack: placeholder('slack', { bot_token: '', signing_secret: '', app_id: '' }),
      cursor: placeholder('cursor', { api_key: '' }),
      langfuse: placeholder('langfuse', {
        public_key: '',
        secret_key: '',
        host: 'https://cloud.langfuse.com',
      }),
    };
  }
}
