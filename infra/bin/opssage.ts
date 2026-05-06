#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { SecretsStack } from '../lib/secrets-stack';
import { EcsStack } from '../lib/ecs-stack';
import { ObservabilityStack } from '../lib/observability-stack';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const network = new NetworkStack(app, 'OpsSage-Network', { env });
const secrets = new SecretsStack(app, 'OpsSage-Secrets', { env });
const ecs = new EcsStack(app, 'OpsSage-Ecs', {
  env,
  vpc: network.vpc,
  cloudMapNamespace: network.cloudMapNamespace,
  secrets: secrets.entries,
  certificateArn: process.env.OPSSAGE_ALB_CERT_ARN,
  alertChannel: process.env.OPSSAGE_ALERT_CHANNEL ?? '#alerts',
});
new ObservabilityStack(app, 'OpsSage-Observability', {
  env,
  agentLogGroupName: ecs.agentLogGroupName,
});

cdk.Tags.of(app).add('app', 'opssage');
cdk.Tags.of(app).add('env', process.env.OPSSAGE_ENV ?? 'prod');
