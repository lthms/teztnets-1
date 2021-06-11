import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as awsx from "@pulumi/awsx";
import * as aws from "@pulumi/aws";
import { createAliasRecord } from "./route53";
import { publicReadPolicyForBucket } from "./s3";
import * as fs from 'fs';
import * as YAML from 'yaml';
const mime = require("mime");


export interface TezosChainParameters {
  chainName?: string;
  containerImage?: string | pulumi.Output<string>;
  dnsName?: string;
  description: string;
  publicBootstrapPeers?: string[];
  bootstrapContracts?: string[];
  bootstrapCommitments?: string;
  helmValuesPath: string,
  k8sRepoPath: string,
  private_baking_key: string,
  private_non_baking_key: string,
}

/**
 * Deploy a tezos-k8s topology in a k8s cluster.
 * Supports either local charts or charts from a repo
 */

export class TezosChain extends pulumi.ComponentResource {
  readonly name: string;
  readonly chainName: string;
  readonly containerImage: string | pulumi.Output<string>;
  readonly route53_name: string;
  readonly description: string;
  readonly publicBootstrapPeers: string[];
  readonly bootstrapContracts: string[];
  readonly bootstrapCommitments: string;
  readonly valuesPath: string;
  readonly k8sRepoPath: string;
  readonly private_baking_key: string;
  readonly private_non_baking_key: string;
  readonly provider: k8s.Provider;
  readonly repo: awsx.ecr.Repository;

  helmValues: any;
  // readonly ns: k8s.core.v1.Namespace;
  // readonly chain: k8s.helm.v2.Chart;

  /**
  * Deploys a private chain on a cluster.
  * @param name The name of the private chain.
  * @param valuesPath The path to the values.yaml file for the helm chart
  * @param
  * @param cluster The kubernetes cluster to deploy it into.
  * @param repo The ECR repository where to push the custom images for this chain.
  */


  constructor(name: string,
              params: TezosChainParameters,
              provider: k8s.Provider,
              repo: awsx.ecr.Repository,
              opts?: pulumi.ResourceOptions) {

    const inputs: pulumi.Inputs = {
      options: opts,
    };

    super("pulumi-contrib:components:TezosChain", name, inputs, opts);

    this.name = name;
    this.chainName = params.chainName || "";
    this.containerImage = params.containerImage || "";
    this.route53_name = params.dnsName || name;
    this.description = params.description;
    this.publicBootstrapPeers = params.publicBootstrapPeers || [];
    this.bootstrapContracts = params.bootstrapContracts || [];
    this.bootstrapCommitments = params.bootstrapCommitments || "";
    this.valuesPath = params.helmValuesPath;
    this.k8sRepoPath = params.k8sRepoPath;
    this.private_baking_key = params.private_baking_key;
    this.private_non_baking_key = params.private_non_baking_key;
    this.provider = provider;
    this.repo = repo;
  
    const helmValuesFile = fs.readFileSync(this.valuesPath, 'utf8');
    const helmValues = YAML.parse(helmValuesFile);
    // if specified, params.chainName overrides node_config_network.chain_name from values.yaml
    helmValues["node_config_network"]["chain_name"] = this.chainName || helmValues["node_config_network"]["chain_name"];

    var ns = new k8s.core.v1.Namespace(name,
      { metadata: { name: name, } },
      { provider: this.provider }
    );

    const defaultHelmValuesFile = fs.readFileSync(`${this.k8sRepoPath}/charts/tezos/values.yaml`, 'utf8');
    const defaultHelmValues = YAML.parse(defaultHelmValuesFile);

    if (("activation" in helmValues) && (this.bootstrapContracts || this.bootstrapCommitments)) {
      const activationBucket = new aws.s3.Bucket(`${name}-activation-bucket`);
      const bucketPolicy = new aws.s3.BucketPolicy(`${name}-activation-bucket-policy`, {
        bucket: activationBucket.bucket,
        policy: activationBucket.bucket.apply(publicReadPolicyForBucket)
      });
      helmValues["activation"]["bootstrap_contract_urls"] = [];

      if (this.bootstrapContracts) {
        this.bootstrapContracts.forEach(function (contractFile: any) {
            const bucketObject = new aws.s3.BucketObject(`${name}-${contractFile}`, {
                bucket: activationBucket.bucket,
                key: contractFile,
                source: new pulumi.asset.FileAsset(`bootstrap_contracts/${contractFile}`),
                contentType: mime.getType(contractFile),
                acl: 'public-read'
            });
            helmValues["activation"]["bootstrap_contract_urls"].push(pulumi.interpolate `https://${activationBucket.bucketRegionalDomainName}/${contractFile}`);
        })
      }

      if (this.bootstrapCommitments) {
        let commitmentFile = this.bootstrapCommitments;
        const bucketObject = new aws.s3.BucketObject(`${name}-${commitmentFile}`, {
          bucket: activationBucket.bucket,
          key: commitmentFile,
          source: new pulumi.asset.FileAsset(`bootstrap_commitments/${commitmentFile}`),
          contentType: mime.getType(commitmentFile),
          acl: 'public-read'
        });
        helmValues["activation"]["commitments_url"] = pulumi.interpolate`https://${activationBucket.bucketRegionalDomainName}/${commitmentFile}`;
      }
    }

    helmValues["accounts"]["tqbaker"]["key"] = this.private_baking_key;
    helmValues["accounts"]["tqfree"]["key"] = this.private_non_baking_key;
    // if specified, parameter overrides container image from values.yaml
    helmValues["images"]["tezos"] = this.containerImage || helmValues["images"]["tezos"]

    const tezosK8sImages = defaultHelmValues["tezos_k8s_images"];
    // do not build zerotier for now since it takes times and it is not used in tqinfra
    delete tezosK8sImages["zerotier"];

    const pulumiTaggedImages = Object.entries(tezosK8sImages).reduce(
      (obj: { [index: string]: any; }, [key]) => {
        obj[key] = this.repo.buildAndPushImage(`${this.k8sRepoPath}/${key.replace(/_/g, "-")}`);
        return obj;
      },
      {}
    );
    helmValues["tezos_k8s_images"] = pulumiTaggedImages;

    this.helmValues = helmValues;

    // deploy from repository
    //this.chain = new k8s.helm.v2.Chart(this.name, {
    //    namespace: this.ns.metadata.name,
    //    chart: 'tezos-chain',
    //    fetchOpts: { repo: k8sRepo },
    //    values: helmValues,
    //}, { providers: { "kubernetes": cluster.provider } });
    // Deploy Tezos into our cluster
    // Deploy from file
    var chain = new k8s.helm.v2.Chart(name, {
      namespace: ns.metadata.name,
      path: `${this.k8sRepoPath}/charts/tezos`,
      values: helmValues,
    }, { providers: { "kubernetes": this.provider } });

    const p2p_lb_service = new k8s.core.v1.Service(
      `${name}-p2p-lb`,
      {
        metadata: {
          namespace: ns.metadata.name,
          name: name,
          annotations: {
            "service.beta.kubernetes.io/aws-load-balancer-type": "nlb-ip",
            "service.beta.kubernetes.io/aws-load-balancer-scheme": "internet-facing",
          },
        },
        spec: {
          ports: [{
            port: 9732,
            targetPort: 9732,
            protocol: "TCP"
          }],
          selector: { app: "tezos-baking-node" },
          type: "LoadBalancer"
        }
      },
      { provider: this.provider }
    );
    let aRecord = p2p_lb_service.status.apply((s) => createAliasRecord(`${this.route53_name}.tznode.net`, s.loadBalancer.ingress[0].hostname));
  }

  getChainName(): string {
    return this.helmValues["node_config_network"]["chain_name"];
  }

  getDescription(): string {
    return this.description;
  }

  getNetworkUrl(baseUrl?: string, relativeUrl?: string): string {
    if ("activation_account_name" in this.helmValues["node_config_network"]) {
      baseUrl = baseUrl || 'https://teztnets.xyz';
      relativeUrl = relativeUrl || this.name;
      return `${baseUrl}/${relativeUrl}`;
    }

    // network config hardcoded in binary, pass the name instead of URL
    return this.name;
  }

  getDockerBuild(): string {
    return this.helmValues["images"]["tezos"];
  }

  getCommand(): string {
    if ("protocols" in this.helmValues) {
      const protocols: [{command: string}] = this.helmValues["protocols"];
      const commands = protocols.map(p => p["command"]);
      return commands.join(", ");
    }

    return this.helmValues["protocol"]["command"];
  }

}
