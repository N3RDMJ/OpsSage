import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  readonly vpc: ec2.IVpc;
  readonly cloudMapNamespace: servicediscovery.IPrivateDnsNamespace;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1, // Cost-conscious; bump to 2 for prod-prod.
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    this.cloudMapNamespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      vpc: this.vpc,
      name: 'opssage.local',
      description: 'OpsSage internal service discovery',
    });
  }
}
