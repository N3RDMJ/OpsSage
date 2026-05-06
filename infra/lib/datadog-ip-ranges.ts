import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

const HANDLER = `
const https = require('https');
const { EC2Client, AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand, DescribeSecurityGroupsCommand } =
  require('@aws-sdk/client-ec2');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function reconcile(sgId, port) {
  const ranges = await fetchJson('https://ip-ranges.datadoghq.com/');
  const desired = new Set((ranges.webhooks?.prefixes_ipv4 ?? []));
  const ec2 = new EC2Client({});
  const sg = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }));
  const existing = new Map();
  for (const rule of sg.SecurityGroups?.[0]?.IpPermissions ?? []) {
    if (rule.FromPort !== port || rule.ToPort !== port || rule.IpProtocol !== 'tcp') continue;
    for (const ip of rule.IpRanges ?? []) existing.set(ip.CidrIp, ip);
  }
  const toAdd = [...desired].filter((cidr) => !existing.has(cidr));
  const toRemove = [...existing.keys()].filter((cidr) => !desired.has(cidr));
  if (toAdd.length) {
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: sgId,
      IpPermissions: [{ IpProtocol: 'tcp', FromPort: port, ToPort: port,
        IpRanges: toAdd.map((CidrIp) => ({ CidrIp, Description: 'datadog-webhooks' })) }],
    }));
  }
  if (toRemove.length) {
    await ec2.send(new RevokeSecurityGroupIngressCommand({
      GroupId: sgId,
      IpPermissions: [{ IpProtocol: 'tcp', FromPort: port, ToPort: port,
        IpRanges: toRemove.map((CidrIp) => ({ CidrIp })) }],
    }));
  }
  return { added: toAdd.length, removed: toRemove.length };
}

exports.handler = async (event) => {
  const sgId = event.ResourceProperties?.SecurityGroupId ?? process.env.SECURITY_GROUP_ID;
  const port = Number(event.ResourceProperties?.Port ?? process.env.PORT ?? 443);
  if (event.RequestType === 'Delete') return { PhysicalResourceId: 'dd-ip-sync' };
  const result = await reconcile(sgId, port);
  return { PhysicalResourceId: 'dd-ip-sync', Data: result };
};
`;

export interface DatadogIpRangesProps {
  securityGroup: ec2.ISecurityGroup;
  port?: number;
}

/** Maintains an inbound rule on `securityGroup` matching Datadog's published webhook IP ranges. */
export class DatadogIpRanges extends Construct {
  constructor(scope: Construct, id: string, props: DatadogIpRangesProps) {
    super(scope, id);

    const port = props.port ?? 443;

    const fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(HANDLER),
      timeout: cdk.Duration.minutes(2),
      environment: { SECURITY_GROUP_ID: props.securityGroup.securityGroupId, PORT: String(port) },
    });
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ec2:DescribeSecurityGroups',
          'ec2:AuthorizeSecurityGroupIngress',
          'ec2:RevokeSecurityGroupIngress',
        ],
        resources: ['*'],
      }),
    );

    new cr.AwsCustomResource(this, 'Initial', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: fn.functionName,
          Payload: JSON.stringify({
            RequestType: 'Create',
            ResourceProperties: { SecurityGroupId: props.securityGroup.securityGroupId, Port: port },
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of('dd-ip-sync-initial'),
      },
      onUpdate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: fn.functionName,
          Payload: JSON.stringify({
            RequestType: 'Update',
            ResourceProperties: { SecurityGroupId: props.securityGroup.securityGroupId, Port: port },
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of('dd-ip-sync-initial'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [fn.functionArn] }),
      ]),
    });

    // Daily refresh as Datadog rotates ranges.
    new events.Rule(this, 'DailyRefresh', {
      schedule: events.Schedule.rate(cdk.Duration.hours(24)),
      targets: [new targets.LambdaFunction(fn)],
    });
  }
}
