#!/bin/bash

# VPCs to delete
VPCS="vpc-031297b86b8086fd5 vpc-08afe62715c8e3017 vpc-07bca6f005e8084ad vpc-0f1c23c4dfb6202a5"

echo "Starting VPC cleanup process..."

for VPC_ID in $VPCS; do
    echo "================================================"
    echo "Processing VPC: $VPC_ID"
    echo "================================================"
    
    # 1. Delete NAT Gateways
    echo "Checking for NAT Gateways..."
    NAT_GATEWAYS=$(aws ec2 describe-nat-gateways --filter "Name=vpc-id,Values=$VPC_ID" --query 'NatGateways[?State!=`deleted`].NatGatewayId' --output text)
    if [ ! -z "$NAT_GATEWAYS" ]; then
        for NAT_GW in $NAT_GATEWAYS; do
            echo "Deleting NAT Gateway: $NAT_GW"
            aws ec2 delete-nat-gateway --nat-gateway-id $NAT_GW
        done
        echo "Waiting for NAT Gateways to be deleted..."
        sleep 30
    fi
    
    # 2. Delete Load Balancers
    echo "Checking for Load Balancers..."
    LOAD_BALANCERS=$(aws elbv2 describe-load-balancers --query "LoadBalancers[?VpcId=='$VPC_ID'].LoadBalancerArn" --output text)
    if [ ! -z "$LOAD_BALANCERS" ]; then
        for LB in $LOAD_BALANCERS; do
            echo "Deleting Load Balancer: $LB"
            aws elbv2 delete-load-balancer --load-balancer-arn $LB
        done
        echo "Waiting for Load Balancers to be deleted..."
        sleep 30
    fi
    
    # 3. Delete Network Interfaces
    echo "Checking for Network Interfaces..."
    NETWORK_INTERFACES=$(aws ec2 describe-network-interfaces --filters "Name=vpc-id,Values=$VPC_ID" --query 'NetworkInterfaces[?Status!=`in-use`].NetworkInterfaceId' --output text)
    if [ ! -z "$NETWORK_INTERFACES" ]; then
        for ENI in $NETWORK_INTERFACES; do
            echo "Deleting Network Interface: $ENI"
            aws ec2 delete-network-interface --network-interface-id $ENI
        done
    fi
    
    # 4. Delete VPC Endpoints
    echo "Checking for VPC Endpoints..."
    VPC_ENDPOINTS=$(aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$VPC_ID" --query 'VpcEndpoints[].VpcEndpointId' --output text)
    if [ ! -z "$VPC_ENDPOINTS" ]; then
        for ENDPOINT in $VPC_ENDPOINTS; do
            echo "Deleting VPC Endpoint: $ENDPOINT"
            aws ec2 delete-vpc-endpoints --vpc-endpoint-ids $ENDPOINT
        done
    fi
    
    # 5. Delete Security Groups (except default)
    echo "Checking for Security Groups..."
    SECURITY_GROUPS=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" --query 'SecurityGroups[?GroupName!=`default`].GroupId' --output text)
    if [ ! -z "$SECURITY_GROUPS" ]; then
        for SG in $SECURITY_GROUPS; do
            echo "Deleting Security Group: $SG"
            aws ec2 delete-security-group --group-id $SG 2>/dev/null || echo "Could not delete $SG (may have dependencies)"
        done
    fi
    
    # 6. Delete Subnets
    echo "Checking for Subnets..."
    SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[].SubnetId' --output text)
    if [ ! -z "$SUBNETS" ]; then
        for SUBNET in $SUBNETS; do
            echo "Deleting Subnet: $SUBNET"
            aws ec2 delete-subnet --subnet-id $SUBNET
        done
    fi
    
    # 7. Delete Route Tables (except main)
    echo "Checking for Route Tables..."
    ROUTE_TABLES=$(aws ec2 describe-route-tables --filters "Name=vpc-id,Values=$VPC_ID" --query 'RouteTables[?Associations[0].Main!=`true`].RouteTableId' --output text)
    if [ ! -z "$ROUTE_TABLES" ]; then
        for RT in $ROUTE_TABLES; do
            echo "Deleting Route Table: $RT"
            aws ec2 delete-route-table --route-table-id $RT
        done
    fi
    
    # 8. Detach and Delete Internet Gateways
    echo "Checking for Internet Gateways..."
    INTERNET_GATEWAYS=$(aws ec2 describe-internet-gateways --filters "Name=attachment.vpc-id,Values=$VPC_ID" --query 'InternetGateways[].InternetGatewayId' --output text)
    if [ ! -z "$INTERNET_GATEWAYS" ]; then
        for IGW in $INTERNET_GATEWAYS; do
            echo "Detaching Internet Gateway: $IGW"
            aws ec2 detach-internet-gateway --internet-gateway-id $IGW --vpc-id $VPC_ID
            echo "Deleting Internet Gateway: $IGW"
            aws ec2 delete-internet-gateway --internet-gateway-id $IGW
        done
    fi
    
    # 9. Release Elastic IPs associated with the VPC
    echo "Checking for Elastic IPs..."
    ALLOCATION_IDS=$(aws ec2 describe-addresses --query "Addresses[?Domain=='vpc' && AssociationId==null].AllocationId" --output text)
    if [ ! -z "$ALLOCATION_IDS" ]; then
        for ALLOC_ID in $ALLOCATION_IDS; do
            echo "Releasing Elastic IP: $ALLOC_ID"
            aws ec2 release-address --allocation-id $ALLOC_ID 2>/dev/null || echo "Could not release $ALLOC_ID"
        done
    fi
    
    # 10. Finally, delete the VPC
    echo "Deleting VPC: $VPC_ID"
    aws ec2 delete-vpc --vpc-id $VPC_ID
    if [ $? -eq 0 ]; then
        echo "Successfully deleted VPC: $VPC_ID"
    else
        echo "Failed to delete VPC: $VPC_ID"
    fi
    
    echo ""
done

echo "VPC cleanup process completed!"