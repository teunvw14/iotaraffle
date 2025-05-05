import type { Wallet, WalletAccount, WindowRegisterWalletEvent } from '@mysten/wallet-standard';
import { IotaClient } from '@iota/iota-sdk/client';
import { Transaction } from '@iota/iota-sdk/transactions';

export let PACKAGE_ID = "0x66a5e577662739d15b2add5ec536cf5e48c9bffd00b05d6e9c0c17819b4584d7";
export let RAFFLE_APP_STATE_ID = "0x114b84deb7d46b0013940a3cb85d74cd61ec37857ee5ae51825ee8f7f037b083";
let MODULE_NAME = "raffle";
let CLOCK_ID = "0x6";
let GAS_BUDGET = 100_000_000;

// Send a transaction to the smart contract, calling `confirm_whale`.
export async function createRaffle(
    iotaClient: IotaClient, 
    wallet: Wallet,
    walletAccount: WalletAccount,
    initialLiquidity: number,
    ticketPrice: number,
    durationSec: number,
    is_giveaway: boolean,
    url: string,
) {
    // Set up the transaction
    let tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);

    let [initialLiquidityCoin] = tx.splitCoins(tx.gas, [initialLiquidity]);
    tx.moveCall({
        package: PACKAGE_ID,
        module: MODULE_NAME,
        function: 'create_raffle',
        arguments: [
            tx.object(RAFFLE_APP_STATE_ID),
            tx.object(initialLiquidityCoin),
            tx.pure.u64(ticketPrice),
            tx.pure.u64(durationSec),
            tx.pure.bool(is_giveaway),
            tx.pure.string(url),
            tx.object.clock,
        ],
        typeArguments: ['0x2::iota::IOTA']
    });

    let {bytes, signature} = 
    await (wallet.features['iota:signTransaction']).signTransaction({
        transaction: tx, 
        account: walletAccount,
    });

    // Send signed transaction to the network for execution
    let transactionResult = await iotaClient.executeTransactionBlock({
        transactionBlock: bytes,
        signature: signature,
    })
    
    // Wait for transaction to complete and parse results
    // await iotaClient.waitForTransaction({ digest: transactionResult.digest });

    // let transactionBlock = await iotaClient.getTransactionBlock({
    //     digest: transactionResult.digest,
    //     options: {
    //         showEffects: true,
    //         showObjectChanges: true,
    //     }
    // });

    // // Show transaction results, if the transaction was successful
    // if (transactionBlock.effects?.status.status == 'success'){
    //     console.log(transactionBlock.objectChanges)
    //     let raffleCreated = transactionBlock.objectChanges?.find((change) => {
    //         return change.objectType.includes("::raffle::Raffle")
    //     });
    //     if (raffleCreated) {
    //         resultText = `Transaction success! Raffle was created with id ${raffleCreated.objectId}.`;
    //         explorerUrl = `https://explorer.rebased.iota.org/object/${raffleCreated.objectId}`;
    //     } else {
    //         resultText = "Transaction succeeded, but ConfirmedWhaleNFT was not created.";
    //     }
    // }
}

    // Send a transaction to the smart contract, calling `confirm_whale`.
export async function buyTicket(
    iotaClient: IotaClient,
    wallet: Wallet,
    walletAccount: WalletAccount,
    raffleId: string,
    ticketPrice: number
) {
    // Set up the transaction
    let tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);

    let [ticket_payment] = tx.splitCoins(tx.gas, [ticketPrice]);
    let ticket = tx.moveCall({
        package: PACKAGE_ID,
        module: MODULE_NAME,
        function: 'buy_ticket',
        arguments: [
            tx.object(raffleId),
            tx.object(ticket_payment)
        ],
        typeArguments: ['0x2::iota::IOTA']
    });
    tx.transferObjects([ticket], walletAccount.address);

    let {bytes, signature} = 
    await (wallet.features['iota:signTransaction']).signTransaction({
        transaction: tx, 
        account: walletAccount,
    });

    // Send signed transaction to the network for execution
    let transactionResult = await iotaClient.executeTransactionBlock({
        transactionBlock: bytes,
        signature: signature,
    })
    
    // Wait for transaction to complete and parse results
    // await iotaClient.waitForTransaction({ digest: transactionResult.digest });
}

export async function enterIntoGiveaway(
    iotaClient: IotaClient,
    wallet: Wallet,
    walletAccount: WalletAccount,
    raffleId: string,
    who: string,
) {
    // Set up the transaction
    let tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);

    let ticket = tx.moveCall({
        package: PACKAGE_ID,
        module: MODULE_NAME,
        function: 'enter_into_giveaway',
        arguments: [
            tx.object(raffleId),
            tx.pure.address(who)
        ],
        typeArguments: ['0x2::iota::IOTA']
    });

    let {bytes, signature} = 
    await (wallet.features['iota:signTransaction']).signTransaction({
        transaction: tx, 
        account: walletAccount,
    });

    // Send signed transaction to the network for execution
    let transactionResult = await iotaClient.executeTransactionBlock({
        transactionBlock: bytes,
        signature: signature,
    })
    
    // Wait for transaction to complete and parse results
    // await iotaClient.waitForTransaction({ digest: transactionResult.digest });
}

export async function resolveRaffle(
    iotaClient: IotaClient,
    wallet: Wallet,
    walletAccount: WalletAccount,
    raffleId: string
) {
    let tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);

    let ticket = tx.moveCall({
        package: PACKAGE_ID,
        module: MODULE_NAME,
        function: 'resolve',
        arguments: [
            tx.object(raffleId),
            tx.object.clock,
            tx.object.random
        ],
        typeArguments: ['0x2::iota::IOTA']
    });

    let {bytes, signature} = 
    await (wallet.features['iota:signTransaction']).signTransaction({
        transaction: tx, 
        account: walletAccount,
    });

    // Send signed transaction to the network for execution
    let transactionResult = await iotaClient.executeTransactionBlock({
        transactionBlock: bytes,
        signature: signature,
    })
    
    // Wait for transaction to complete and parse results
    // await iotaClient.waitForTransaction({ digest: transactionResult.digest });
}

export async function claimRafflePrize(
    iotaClient: IotaClient,
    wallet: Wallet,
    walletAccount: WalletAccount,
    raffleId: string,
    winningTicket: string) {
    let tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);

    let prize = tx.moveCall({
        package: PACKAGE_ID,
        module: MODULE_NAME,
        function: 'claim_prize_money',
        arguments: [
            tx.object(raffleId),
            tx.object(winningTicket)
        ],
        typeArguments: ['0x2::iota::IOTA']
    });

    tx.transferObjects([prize], walletAccount.address);

    let {bytes, signature} = 
    await (wallet.features['iota:signTransaction']).signTransaction({
        transaction: tx, 
        account: walletAccount,
    });

    // Send signed transaction to the network for execution
    let transactionResult = await iotaClient.executeTransactionBlock({
        transactionBlock: bytes,
        signature: signature,
    })
    
    // Wait for transaction to complete and parse results
    // await iotaClient.waitForTransaction({ digest: transactionResult.digest });
}