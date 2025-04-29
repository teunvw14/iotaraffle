<script lang="ts">
    import { getWallets, WalletStandardError } from '@mysten/wallet-standard';
    import { getFullnodeUrl, IotaClient, type IotaObjectResponse } from '@iota/iota-sdk/client';
    import { Transaction } from '@iota/iota-sdk/transactions';
    import { onMount } from 'svelte';
    import {nanosToIota, shortenHex, timeHumanReadable} from '$lib/util'
    import { createRaffle, buyTicket, resolveRaffle, claimRafflePrize } from '$lib/smart_contract_calls' 

    let PACKAGE_ID = "0x907230b93bd2bb30b0aae756831464d6a514cf0bf12b9253840d6757e9c65164";
    let RAFFLE_APP_STATE_ID = "0x16353ac49929c66ad2c4e09e4ebcbd5dd7c959a919709061433fc8f4c3331a77";
    let MODULE_NAME = "raffle";

    let activeWallet = $state(null);
    let activeWalletAccount = $state(null);
    let activeWalletAccountBalance = $state(0);
    let newRaffleInitialLiquidity = $state(5);
    let newRaffleInitialLiquidityNanos = $derived(newRaffleInitialLiquidity * 1_000_000_000)
    let newRaffleTicketPrice = $state(0.1);
    let newRaffleTicketPriceNanos = $derived(newRaffleTicketPrice * 1_000_000_000)
    let newRaffleDurationSec = $state(100);
    let resultText = $state("");
    let explorerUrl = $state("");
    let onChainClockTimestampMs = $state(0);

    let allRaffles = $state([]);

    const iotaClient = new IotaClient({ url: getFullnodeUrl('testnet') });

    async function connectWallet() {
        let wallets = getWallets().get();
        if (wallets.length == 0) {
            console.log("No wallets found to connect to. Make sure you installed an IOTA web wallet.");
            return;
        }
        // Make sure we get the right wallet
        activeWallet = wallets.find((w) => w.name == "IOTA Wallet");
        if (!activeWallet) {
            console.log("No IOTA wallets found to connect to. Make sure you installed an IOTA web wallet.");
            return;
        }
        activeWallet.features['standard:connect'].connect();
        activeWallet.features['standard:events'].on("change", () => {
            activeWalletAccount = activeWallet.accounts[0];
            updateBalance();
        });

        delayedRenewState();
    }
    
    async function initOnChainClockTimestampMs() {
        let clock = await iotaClient.getObject({id: '0x06', options: {showContent: true}});
        onChainClockTimestampMs = parseFloat(clock.data?.content.fields["timestamp_ms"]);

        clockUpdate();
    }

    function clockUpdate() {
        setTimeout(() => {
            onChainClockTimestampMs += 1000;
            clockUpdate();
        }, 1000);
    }

    // Helper function to update the balance of the activeWalletAccount
    async function updateBalance() {
        if (activeWalletAccount) {
            activeWalletAccountBalance = (await iotaClient.getBalance({owner: activeWalletAccount.address})).totalBalance;
        }
    }

    async function ownsTicket(ticketId) {
        let ticket = await iotaClient.getObject({id: ticketId, options: {showOwner: true}});
        let res = ticket.data?.owner["AddressOwner"] == activeWalletAccount.address;
        return res;
    }

    interface Raffle {
        id: string,
        prize_money: number,
        ticket_price: number,
        redemption_timestamp_ms: number,
        tickets_sold: number,
        winning_ticket?: string,
        active_address_owns_winning_ticket: boolean
    }

    function parseRaffles(raffles_object) {
        return raffles_object.map((raffle: IotaObjectResponse) => {
            let res: Raffle = {
                id: raffle.data.objectId,
                prize_money: raffle.data.content.fields["prize_money"],
                ticket_price: raffle.data.content.fields["ticket_price"],
                redemption_timestamp_ms: raffle.data.content.fields["redemption_timestamp_ms"],
                tickets_sold: raffle.data.content.fields["sold_tickets"].length,
                winning_ticket: raffle.data.content.fields["winning_ticket"],
                active_address_owns_winning_ticket: false
            }
            return res
        });
    }

    // TODO: fix this buggy mess
    async function updateWinningTicketOwner() {
        let i = 0;
        while (i < allRaffles.length) {
            let raffle = allRaffles[i];
            if (raffle.winning_ticket) {
                raffle.active_address_owns_winning_ticket = await ownsTicket(raffle.winning_ticket);
            }
        }
    }

    function delayedRenewState() {
        setTimeout(() => updateRaffles (), 3_000);
        setTimeout(() => updateRaffles (), 7_500);
    }

    async function updateRaffles() {
        let raffles_app_state = await iotaClient.getObject({id: RAFFLE_APP_STATE_ID, options: {showContent: true}});
        // console.log(raffles_app_state);
        let raffle_ids = raffles_app_state.data?.content.fields["raffles"];

        let raffles = await iotaClient.multiGetObjects({ids: raffle_ids, options: {showContent: true}});
        allRaffles = await parseRaffles(raffles);
        allRaffles.sort((raffle_1: Raffle, raffle_2: Raffle) => { 
            if(raffle_1.prize_money == 0) {
                return 1
            } else if(raffle_2.prize_money == 0) {
                return -1
            } else {
                return raffle_1.redemption_timestamp_ms - raffle_2.redemption_timestamp_ms;
            }
        })

        updateWinningTicketOwner();
    }

    onMount(() => {
        connectWallet();
        delayedRenewState();
        initOnChainClockTimestampMs();
    })
</script>

<div class="flex flex-row w-full">
    <p> On chain time: {onChainClockTimestampMs}</p>
</div>

<div class="m-4 border-red-400 border-4">

    <h1>
        Create a new Raffle!
    </h1>

    <!-- Button for connecting to an IOTA wallet -->
    <button 
        onclick={connectWallet}
        class="bg-blue-500 p-2"
    >
        {activeWallet ? 'Connected' : 'Connect wallet'}
    </button>

    <!-- Display for the balance of the active walletAccount -->
    <p>{activeWalletAccount ? `Connected wallet ${shortenHex(activeWalletAccount.address)} | Balance: ${nanosToIota(activeWalletAccountBalance)} IOTA` : 'Connect a wallet to show balance'}</p>

    <hr/>

    <!-- Input for how many NANOs to send to the smart contract -->
    <h3>Initial Liquidity for Raffle (minimum is 5 IOTA)</h3>
    
    <input bind:value={newRaffleInitialLiquidity}
        type="number" 
        lang="en" 
        placeholder="5.0"
        step="0.000000001" 
        min="0.000000001"
        class="border-2 border-blue-800 m-2"
    >
    <h3>Ticket price for Raffle (minimum is 0.01 IOTA)</h3>
    <input bind:value={newRaffleTicketPrice}
        type="number" 
        lang="en" 
        placeholder="0.01"
        step="0.000000001" 
        min="0.000000001"
        class="border-2 border-blue-800 m-2"
    >
    <h3>New Raffle Duration in seconds</h3>
    <input bind:value={newRaffleDurationSec}
        type="number" 
        lang="en" 
        placeholder="3600"
        step="1"
        min="10"
        class="border-2 border-blue-800 m-2"
    >

    <!-- Button that allows for interaction with the smart contract -->
    <button 
        onclick={() => {createRaffle(iotaClient, activeWallet, activeWalletAccount, newRaffleInitialLiquidityNanos, newRaffleTicketPriceNanos, newRaffleDurationSec); delayedRenewState()}}
        class="bg-blue-500 p-2"
        disabled={!activeWalletAccount}
    >
        {activeWalletAccount ? "Create Raffle" : "Connect a wallet to interact with smart contract."}
    </button>

    <!-- Display of the result of the transaction -->
    <p>{resultText}</p>
    <a 
        href={explorerUrl} target="_blank"
        class="bg-green-300"
    >
        {explorerUrl == "" ? "" : "Check out the Raffle on the IOTA Rebased explorer"}
    </a>

</div>

<div class="m-4 border-blue-500">
    <h1>
        Existing Raffles
    </h1>

    {#each allRaffles as raffle}
    {#if raffle.prize_money != 0}
    <div class="border-2 border-amber-800 m-2">
        <a href="https://explorer.rebased.iota.org/object/{raffle.id}" target="_blank"><p>{shortenHex(raffle.id)}</p></a>
        <h1>Prize pool is: {nanosToIota(raffle.prize_money)} IOTA</h1>
        <h2>Ticket price is: {nanosToIota(raffle.ticket_price)} IOTA</h2>
        <h2>Ticket expected value: {nanosToIota(raffle.prize_money/(raffle.tickets_sold + 1))} IOTA</h2>
        {#if raffle.winning_ticket == null}
        <h2>{timeHumanReadable(raffle.redemption_timestamp_ms - onChainClockTimestampMs)} </h2>
        {/if}
        {#if raffle.winning_ticket != null}
            <h2>Raffle resolved!</h2>
            <h2>Winning ticket: {shortenHex(raffle.winning_ticket)}</h2>
        {/if}
        {#if raffle.winning_ticket == null}
        <button onclick={()=>{buyTicket(iotaClient, activeWallet, activeWalletAccount, raffle.id, raffle.ticket_price); delayedRenewState()}}
            class="bg-green-500">
            Buy Ticket ({nanosToIota(raffle.ticket_price)} IOTA)
        </button>
        {/if}
        {#if raffle.winning_ticket != null && raffle.prize_money != 0 && raffle.active_address_owns_winning_ticket && raffle.active_address_owns_winning_ticket}
            <button onclick={()=>{claimRafflePrize(iotaClient, activeWallet, activeWalletAccount, raffle.id, raffle.winning_ticket); delayedRenewState()}}
                class="bg-green-300">
                <b>Claim prize!</b>
            </button>
        {/if}
        {#if raffle.winning_ticket == null && raffle.redemption_timestamp_ms - onChainClockTimestampMs <= 0}
            <button onclick={()=>{resolveRaffle(iotaClient, activeWallet, activeWalletAccount, raffle.id); delayedRenewState()}}
            class="bg-purple-400">
                Resolve Raffle
            </button>
        {/if}
    </div>
    {/if}
    {/each}
    
</div>