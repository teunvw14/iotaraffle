<script lang="ts">
    import { getWallets, WalletStandardError } from '@mysten/wallet-standard';
    import { getFullnodeUrl, IotaClient, type IotaObjectResponse } from '@iota/iota-sdk/client';
    import { Transaction } from '@iota/iota-sdk/transactions';
    import { onMount } from 'svelte';
    import { nanosToIota, shortenHex, timeHumanReadable, getObjectExplorerUrl, roundFractional } from '$lib/util'
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
    
    let explorerUrl = "https://explorer.rebased.iota.org/";
    let onChainClockTimestampMs = $state(0);

    let allRaffles = $state([]);
    let showCompletedRaffles = $state(false);
    let activeWalletOwnedTickets: string[] = $state([]);

    const iotaClient = new IotaClient({ url: getFullnodeUrl('testnet') });

    async function initializeWallet() {
        let wallets = getWallets().get();
        if (wallets.length == 0) {
            console.log("No wallets found to connect to. Make sure you installed an IOTA web wallet.");
            return;
        }

        let eligibleWallets = wallets.filter((w) => {
            return (
                ["IOTA Wallet", "Nightly"].includes(w.name) &&
                (w.chains.includes("iota:testnet") ||
                 w.chains.includes("iota:mainnet"))
            );
        })

        activeWallet = eligibleWallets[0];
        if (!activeWallet) {
            console.log("No IOTA wallets found to connect to. Make sure you installed an IOTA web wallet.");
            return;
        }
    }

    async function connectWallet() {
        await activeWallet.features['standard:connect'].connect();
        activeWalletAccount = activeWallet.accounts[0];
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

    function ownsTicket(ticketId) {
        return !!ticketId && activeWalletOwnedTickets.includes(ticketId);
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

    interface Ticket {
        id: string
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

    async function updateWinningTicketOwner() {
        await updateOwnedTickets();
        allRaffles.forEach((raffle: Raffle) => {
            if (!!raffle.winning_ticket) {
                if (activeWalletOwnedTickets.includes(raffle.winning_ticket)) {
                    raffle.active_address_owns_winning_ticket = true;
                }
            }
        });
    }

    async function updateOwnedTickets() {
        let holdings = await iotaClient.getOwnedObjects({owner: activeWalletAccount.address, options: {showContent: true}});
        let ticketObjects = holdings.data.filter((obj) => {
            return obj.data?.content?.type.includes(PACKAGE_ID+'::raffle::RaffleTicket');
        });
        let ticketIds = ticketObjects.map((obj) => {
            return obj.data?.objectId;
        })
        activeWalletOwnedTickets = ticketIds;
    }

    function renewState() {
        updateRaffles();
        updateBalance();
    }

    function delayedRenewState() {
        setTimeout(() => renewState (), 3_000);
        setTimeout(() => renewState (), 7_500);
    }

    async function updateRaffles() {
        let raffles_app_state = await iotaClient.getObject({id: RAFFLE_APP_STATE_ID, options: {showContent: true}});
        // console.log(raffles_app_state);
        let raffle_ids = raffles_app_state.data?.content.fields["raffles"];

        let raffles = await iotaClient.multiGetObjects({ids: raffle_ids, options: {showContent: true}});
        let parsedRaffles = await parseRaffles(raffles);

        let winningUnclaimedRaffles = parsedRaffles.filter((raffle: Raffle) => {
            return !!raffle.winning_ticket && raffle.prize_money > 0 && ownsTicket(raffle.winning_ticket)
        });
        let unresolvedRaffles = parsedRaffles.filter((raffle: Raffle) => {
            return !raffle.winning_ticket
        })
        let lostUnclaimedRaffles = parsedRaffles.filter((raffle: Raffle) => {
            return !!raffle.winning_ticket && raffle.prize_money > 0 && !ownsTicket(raffle.winning_ticket)
        });
        let completedRaffles = parsedRaffles.filter((raffle: Raffle) => {
            return raffle.prize_money == 0
        });
        winningUnclaimedRaffles.sort((r1, r2) => r1.redemption_timestamp_ms - r2.redemption_timestamp_ms);
        unresolvedRaffles.sort((r1, r2) => r1.redemption_timestamp_ms - r2.redemption_timestamp_ms);
        lostUnclaimedRaffles.sort((r1, r2) => r1.redemption_timestamp_ms - r2.redemption_timestamp_ms);
        completedRaffles.sort((r1, r2) => r1.redemption_timestamp_ms - r2.redemption_timestamp_ms);
        
        allRaffles = winningUnclaimedRaffles.concat(unresolvedRaffles).concat(lostUnclaimedRaffles).concat(completedRaffles);
        // console.log(allRaffles)
        updateWinningTicketOwner();
    }

    onMount(() => {
        initializeWallet();
        connectWallet();
        updateRaffles();
        initOnChainClockTimestampMs();
    })
</script>

<div class="min-h-screen bg-gray-100 p-4 md:p-8 font-sans">
    <div class="max-w-2xl mx-auto">

        <div class="flex flex-col justify-between mb-4 mx-4">
            <div class="w-full flex flex-row justify-between">
                <h1 class="text-2xl">🎡 IOTA Raffle 🎡</h1>
                <h2 class="text-sm md:text-md text-emerald-600">Testnet</h2>
            </div>
        </div>

        <div class="flex flex-col space-y-8">

            <section class="bg-blue-100 p-6 rounded-lg shadow-md border-4 border-blue-300">
                <h1 class="text-2xl font-semibold text-gray-800 mb-5 border-b pb-3">
                    Create New Raffle
                </h1>

                <div class="mb-6 p-4 bg-gray-50 border border-gray-200 rounded-md">
                    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                        <button
                            onclick={connectWallet}
                            class="bg-orange-500 hover:bg-orange-400 text-white font-bold py-2 px-4 rounded transition duration-150 ease-in-out disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                            {!!activeWalletAccount ? 'Wallet Connected ✅' : 'Connect Wallet'}
                        </button>
                        <div class="text-sm text-gray-700 text-center sm:text-right">
                            {#if activeWalletAccount}
                                <p>Account: <span class="font-mono bg-gray-200 px-1 rounded">{shortenHex(activeWalletAccount.address, 4)}</span></p>
                                <p class="mt-1">Balance: <span class="font-semibold">{nanosToIota(activeWalletAccountBalance)} IOTA</span></p>
                            {:else}
                                <p class="italic text-gray-500">Connect wallet to create a raffle, or join existing ones.</p>
                            {/if}
                        </div>
                    </div>
                </div>

                {#if activeWalletAccount}
                    <div class="space-y-4">
                        <div>
                            <label for="initialLiquidity" class="block text-sm font-medium text-gray-700 mb-1">Initial Liquidity (min 5 IOTA)</label>
                            <input id="initialLiquidity" bind:value={newRaffleInitialLiquidity}
                                type="number" lang="en" placeholder="5.0" step="0.000000001" min="5" required
                                class="mt-1 block w-full rounded-md border-2 shadow-sm bg-white border-indigo-200 focus:border-indigo-600 focus:ring-indigo-600 sm:text-sm p-2"
                            >
                        </div>

                        <div>
                            <label for="ticketPrice" class="block text-sm font-medium text-gray-700 mb-1">Ticket Price (min 0.01 IOTA)</label>
                            <input id="ticketPrice" bind:value={newRaffleTicketPrice}
                                type="number" lang="en" placeholder="0.1" step="0.000000001" min="0.01" required
                                class="mt-1 block w-full rounded-md border-2 shadow-sm bg-white border-indigo-200 focus:border-indigo-600 focus:ring-indigo-600 sm:text-sm p-2"
                            >
                        </div>

                        <div>
                            <label for="duration" class="block text-sm font-medium text-gray-700 mb-1">Raffle Duration (seconds)</label>
                            <input id="duration" bind:value={newRaffleDurationSec}
                                type="number" lang="en" placeholder="100" step="1" min="10" required
                                class="mt-1 block w-full rounded-md border-2 shadow-sm bg-white border-indigo-200 focus:border-indigo-600 focus:ring-indigo-600 sm:text-sm p-2"
                            >
                        </div>

                        <div class="pt-3 w-full">
                             <button    
                                 onclick={() => {createRaffle(iotaClient, activeWallet, activeWalletAccount, newRaffleInitialLiquidityNanos, newRaffleTicketPriceNanos, newRaffleDurationSec); delayedRenewState()}}
                                 class="w-full h-16 bg-indigo-600 hover:bg-indigo-700 text-white text-xl font-bold py-2 px-6 rounded transition duration-150 ease-in-out disabled:opacity-50 disabled:cursor-not-allowed hover:cursor-pointer"
                                 disabled={!activeWalletAccount}
                             >
                             ✨ Create Raffle ✨
                             </button>
                         </div>
                    </div>
                {:else}
                    <p class="text-center text-gray-500 italic mt-6">Connect your wallet to create a raffle.</p>
                {/if}

            </section>

            <section class=" p-6 mb-6 rounded-lg shadow-md border-4 bg-orange-100 border-amber-400 flex flex-col">
                <div class="flex justify-between items-center border-b pb-3 mb-5">
                    <h1 class="text-2xl font-semibold text-gray-800">
                        Existing Raffles
                    </h1>
                    <div class="flex items-center space-x-2">
                        <label for="showCompleted" class="text-sm text-gray-600 whitespace-nowrap">Show Completed:</label>
                        <input id="showCompleted" type="checkbox" bind:checked={showCompletedRaffles} class="rounded border-gray-300 text-indigo-600 shadow-sm focus:border-indigo-300 focus:ring focus:ring-offset-0 focus:ring-indigo-200 focus:ring-opacity-50 h-4 w-4 cursor-pointer">
                    </div>
                </div>

                <div class="flex-grow min-h-0 overflow-y-auto max-h-[65vh] pr-2 space-y-4">
                     {#if allRaffles.length === 0}
                        <p class="text-center text-gray-500 py-10">No active raffles found.</p>
                     {:else}
                        {#each allRaffles as raffle}
                            {#if (raffle.prize_money != 0 && (!raffle.winning_ticket || ownsTicket(raffle.winning_ticket))) || showCompletedRaffles}
                                <div class="border-2 border-amber-400 bg-gradient-to-br from-amber-200 to-red-400 rounded-lg p-4 shadow-xl transition-shadow hover:shadow-md">
                                    <div class="flex justify-between items-start mb-3">
                                        <a href={getObjectExplorerUrl(explorerUrl, raffle.id)} target="_blank" rel="noopener noreferrer" class="text-sm font-mono text-slate-500 hover:underline break-all pr-4" title={`Raffle ID: ${raffle.id}`}>
                                             {shortenHex(raffle.id, 8)}
                                        </a>
                                        {#if raffle.prize_money == 0 && raffle.winning_ticket != null}
                                             <span class="text-xs font-semibold bg-gray-400 text-white px-2 py-0.5 rounded-full whitespace-nowrap">Completed</span>
                                         {:else if raffle.winning_ticket != null}
                                             <span class="text-xs font-semibold bg-green-600 text-white px-2 py-0.5 rounded-full whitespace-nowrap">Prize Ready to Claim</span>
                                        {:else if raffle.redemption_timestamp_ms - onChainClockTimestampMs <= 0}
                                            <span class="text-xs font-semibold bg-purple-500 text-white px-2 py-0.5 rounded-full whitespace-nowrap">Ready to resolve</span>
                                        {:else}
                                            <span class="text-xs font-semibold bg-blue-500 text-white px-2 py-0.5 rounded-full whitespace-nowrap">Active</span>
                                        {/if}
                                    </div>

                                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 mb-3 text-sm">
                                        <div class="flex flex-row sm:flex-col sm:justify-between pb-1 ">
                                            <p class="text-gray-800 text-2xl mr-2"><span class="font-bold">Prize Pool:</span> </p>
                                            <p class="text-green-800 text-2xl sm:text-4xl">{roundFractional(nanosToIota(raffle.prize_money), 2)} IOTA</p>
                                        </div>
                                        <div>
                                            <p class="text-gray-800 text-xl"><span class="font-bold">Ticket Price:</span> {nanosToIota(raffle.ticket_price)} IOTA</p>
                                            <p class="text-gray-800"><span class="font-bold">Tickets Sold:</span> {raffle.tickets_sold}</p>
                                            {#if raffle.winning_ticket == null && raffle.redemption_timestamp_ms - onChainClockTimestampMs > 0}
                                            <p class="text-gray-800 col-span-1 sm:col-span-2"><span class="font-bold">Ticket Expected Value:</span> ~{roundFractional(nanosToIota(raffle.prize_money/(raffle.tickets_sold + 1)), 2)} IOTA</p>
                                            <p class="text-gray-800"><span class="font-bold">Ends in:</span> <span class="font-semibold text-blue-700">{timeHumanReadable(raffle.redemption_timestamp_ms - onChainClockTimestampMs)}</span></p>
                                           {:else if raffle.winning_ticket != null}
                                               <p class="text-gray-800 col-span-1 sm:col-span-2"><span class="font-bold">Winning Ticket:</span> {shortenHex(raffle.winning_ticket, 6)}</p>
                                            {/if}
                                        </div>
                                    </div>

                                    <div class="flex flex-wrap gap-2 items-center pt-3 border-t border-amber-200 mt-3">
                                        {#if (raffle.winning_ticket == null && raffle.redemption_timestamp_ms - onChainClockTimestampMs > 0) || raffle.tickets_sold === 0}
                                            <button
                                                onclick={()=>{buyTicket(iotaClient, activeWallet, activeWalletAccount, raffle.id, raffle.ticket_price); delayedRenewState()}}
                                                disabled={!activeWalletAccount || raffle.ticket_price > activeWalletAccountBalance}
                                                class="w-full bg-green-500 hover:bg-green-600 text-white text-md font-semibold py-1.5 px-3 rounded shadow-sm transition duration-150 ease-in-out cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                            {#if raffle.redemption_timestamp_ms - onChainClockTimestampMs < 0}
                                            🎟️ Buy First Ticket To Claim Prize Pool ({nanosToIota(raffle.ticket_price)} IOTA) 🎟️
                                            {:else}
                                             🎟️ Buy Ticket ({nanosToIota(raffle.ticket_price)} IOTA) 🎟️
                                            {/if}
                                            </button>
                                        {/if}

                                        {#if raffle.winning_ticket != null && raffle.prize_money != 0 && raffle.active_address_owns_winning_ticket}
                                            <button
                                                onclick={()=>{claimRafflePrize(iotaClient, activeWallet, activeWalletAccount, raffle.id, raffle.winning_ticket); delayedRenewState()}}
                                                disabled={!activeWalletAccount}
                                                class="w-full bg-yellow-400 hover:bg-yellow-500 text-black text-md font-bold py-1.5 px-3 rounded shadow-sm transition duration-150 ease-in-out cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed animate-pulse"
                                            >
                                                💰 Claim Prize ({roundFractional(nanosToIota(raffle.prize_money), 2)} IOTA) 💰
                                            </button>
                                        {/if}

                                         {#if raffle.winning_ticket == null && raffle.redemption_timestamp_ms - onChainClockTimestampMs <= 0 && raffle.prize_money > 0 && raffle.tickets_sold > 0}
                                            <button
                                                onclick={()=>{resolveRaffle(iotaClient, activeWallet, activeWalletAccount, raffle.id); delayedRenewState()}}
                                                disabled={!activeWalletAccount}
                                                class="w-full bg-purple-500 hover:bg-purple-600 text-white text-md font-semibold py-1.5 px-3 rounded shadow-sm transition duration-150 ease-in-out cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                            🏁 Resolve Raffle 🏁
                                            </button>
                                         {/if}

                                         {#if raffle.prize_money == 0 && raffle.winning_ticket != null}
                                             <p class="text-sm text-gray-500 italic">Prize claimed.</p>
                                         {/if}
                                    </div>
                                </div>
                            {/if}
                        {/each}
                     {/if}
                </div> </section>
        </div> 
        <div class="flex flex-col bg-white p-6 rounded-lg shadow-md border border-gray-200">
            <p class="text-xs md:text-sm text-gray-600 mb-2">
                On-Chain Time: {onChainClockTimestampMs > 0 ? new Date(onChainClockTimestampMs).toLocaleString() : 'Syncing...'}
            </p>
            <h1 class="font-bold text-2xl mb-2">What is this?</h1>
            <p class="mb-2">Start your own raffle, or join someone else's raffle by buying a ticket! IOTARaffle is a dApp the IOTA Rebased network, created to celebrate the release of the IOTA Rebased network. The code for the Move smart contract behind this dApp can be found <a class="text-blue-500" href="https://github.com/teunvw14/move-raffle-v2" target="_blank">here</a>. </p>
            <h1 class="font-bold text-xl mb-2">How it works</h1>
            <p class="mb-4">You can buy tickets for a raffle until its resolution time. It then needs to be resolved, which will select a winning ticket. If you own the winning ticket, it will show at the top of the raffle list, and you can claim the prize money. </p>
            <p class="text-xs">Created by Teun van Wezel</p>
        </div>
    </div>
</div> 
        
<style>
    .overflow-y-auto::-webkit-scrollbar {
        width: 6px;
    }
    .overflow-y-auto::-webkit-scrollbar-track {
        background: #f1f1f1;
        border-radius: 10px;
    }
    .overflow-y-auto::-webkit-scrollbar-thumb {
        background: #cccccc;
        border-radius: 10px;
    }
    .overflow-y-auto::-webkit-scrollbar-thumb:hover {
        background: #aaaaaa;
    }
    /* Hide number input arrows */
    input[type=number]::-webkit-inner-spin-button,
    input[type=number]::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
    }
    input[type=number] {
        -moz-appearance: textfield;
    }
</style>