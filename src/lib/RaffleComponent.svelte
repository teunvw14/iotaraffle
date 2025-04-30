<script lang="ts">
    import { getWallets, WalletStandardError } from '@mysten/wallet-standard';
    import { getFullnodeUrl, IotaClient, type IotaObjectResponse } from '@iota/iota-sdk/client';
    import { Transaction } from '@iota/iota-sdk/transactions';
    import { onMount } from 'svelte';
    import { nanosToIota, shortenHex, timeHumanReadable, getObjectExplorerUrl, roundFractional } from '$lib/util'
    import { createRaffle, buyTicket, enterIntoGiveaway, resolveRaffle, claimRafflePrize, PACKAGE_ID, RAFFLE_APP_STATE_ID } from '$lib/smart_contract_calls' 

    let MODULE_NAME = "raffle";

    let activeWallet = $state(null);
    let activeWalletAccount = $state(null);
    let activeWalletAccountBalance = $state(0);

    let newRaffleInitialLiquidity = $state(5);
    let newRaffleInitialLiquidityNanos = $derived(newRaffleInitialLiquidity * 1_000_000_000)
    let newRaffleTicketPrice = $state(0.1);
    let newRaffleTicketPriceNanos = $derived(newRaffleTicketPrice * 1_000_000_000)
    let newRaffleDurationSec = $state(100);
    let newRaffleUrl = $state("");
    let newRaffleIsGiveaway = $state(false);

    let resultText = $state("");
    
    let explorerUrl = "https://explorer.rebased.iota.org/";
    let onChainClockTimestampMs = $state(0);

    let allRaffles = $state([]);
    let allGiveaways = $state([]);
    let showCompletedRaffles = $state(false);
    let showCompletedGiveaways = $state(false);
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
        creator: string,
        prize_money: number,
        ticket_price: number,
        redemption_timestamp_ms: number,
        tickets_sold: number,
        winning_ticket?: string,
        is_giveaway: boolean,
        url: string,
        active_address_owns_winning_ticket: boolean,
    }

    interface Ticket {
        id: string
    }

    function parseRaffles(raffles_object) {
        return raffles_object.map((raffle: IotaObjectResponse) => {
            let res: Raffle = {
                id: raffle.data.objectId,
                creator: raffle.data.content.fields["creator"],
                prize_money: raffle.data.content.fields["prize_money"],
                ticket_price: raffle.data.content.fields["ticket_price"],
                redemption_timestamp_ms: raffle.data.content.fields["redemption_timestamp_ms"],
                tickets_sold: raffle.data.content.fields["sold_tickets"].length,
                winning_ticket: raffle.data.content.fields["winning_ticket"],
                is_giveaway: raffle.data.content.fields["is_giveaway"],
                url: String.fromCharCode(...raffle.data.content.fields["url"]),
                active_address_owns_winning_ticket: false,
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
        allGiveaways.forEach((raffle: Raffle) => {
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
        
        let rafflesAndGiveaways = winningUnclaimedRaffles.concat(unresolvedRaffles).concat(lostUnclaimedRaffles).concat(completedRaffles);
        allRaffles = rafflesAndGiveaways.filter((rg) => !rg.is_giveaway);
        allGiveaways = rafflesAndGiveaways.filter((rg) => rg.is_giveaway);
        allGiveaways.sort((r1, r2) => {
            if (r1.creator == activeWalletAccount.address && r2.creator != activeWalletAccount.address) {
                return -1;
            } else if (r1.creator != activeWalletAccount.address && r2.creator == activeWalletAccount.address) {
                return 1;
            } else {
                return 1;
            }
        })
        // console.log(allRaffles)
        // console.log(allGiveaways)
        updateWinningTicketOwner();
    }

    onMount(() => {
        updateRaffles();
        console.log('hello')
        initializeWallet();
        connectWallet();
        initOnChainClockTimestampMs();
    })
</script>

<div class="min-h-screen bg-slate-100 p-4 md:p-8 font-sans">
    <div class="max-w-xl mx-auto">

        <div class="flex flex-col justify-between mb-4 mx-4">
            <div class="w-full flex flex-row justify-between">
                <h1 class="text-2xl">🎡 IOTA Raffle 🎡</h1>
                <h2 class="text-sm md:text-md text-emerald-600">Testnet</h2>
            </div>
        </div>

        <div class="flex flex-col space-y-8">

            <section class="bg-blue-100 p-6 rounded-lg shadow-md border-4 border-blue-300">
                <h1 class="text-2xl font-semibold text-gray-800 mb-5 border-b pb-3">
                    Create New Raffle or Giveaway
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
                            <label for="initialLiquidity" class="block text-sm text-gray-700 mb-1">Initial Liquidity (min 5 IOTA)</label>
                            <input id="initialLiquidity" bind:value={newRaffleInitialLiquidity}
                                type="number" lang="en" placeholder="5.0" step="0.000000001" min="5" required
                                class="mt-1 block w-full rounded-md border-2 shadow-sm bg-white border-indigo-200 focus:border-indigo-600 focus:ring-indigo-600 sm:text-sm p-2"
                            >
                        </div>

                        {#if !newRaffleIsGiveaway}
                        <div>
                            <label for="ticketPrice" class="block text-sm text-gray-700 mb-1">Ticket Price</label>
                            <input id="ticketPrice" bind:value={newRaffleTicketPrice}
                                type="number" lang="en" placeholder="0.1" step="0.000000001" min="0.0" required
                                class="mt-1 block w-full rounded-md border-2 shadow-sm bg-white border-indigo-200 focus:border-indigo-600 focus:ring-indigo-600 sm:text-sm p-2"
                            >
                        </div>
                        {/if}
                        <div>
                            <label for="duration" class="block text-sm text-gray-700 mb-1">Raffle / Giveaway Duration (seconds)</label>
                            <input id="duration" bind:value={newRaffleDurationSec}
                                type="number" lang="en" placeholder="100" step="1" min="10" required
                                class="mt-1 block w-full rounded-md border-2 shadow-sm bg-white border-indigo-200 focus:border-indigo-600 focus:ring-indigo-600 sm:text-sm p-2"
                            >
                        </div>

                        <div>
                            <label for="initialLiquidity" class="block text-sm text-gray-700 mb-1">Raffle / Giveaway / Project URL</label>
                            <input id="initialLiquidity" bind:value={newRaffleUrl}
                                class="mt-1 block w-full rounded-md border-2 shadow-sm bg-white border-indigo-200 focus:border-indigo-600 focus:ring-indigo-600 sm:text-sm p-2"
                            >
                        </div>
                        <div class="flex flex-row">
                            {#if newRaffleIsGiveaway}
                            <button 
                                onclick={() => {newRaffleIsGiveaway = false}}
                                class="w-full bg-white rounded text-md p-2 border-2 border-amber-400 hover:cursor-pointer hover:bg-amber-100"
                            >
                            🎰 Make It a Raffle 🎰
                        </button>
                        {:else}
                        <button 
                            onclick={() => {newRaffleIsGiveaway = true}}
                            class="w-full bg-white rounded text-md p-2 border-2 border-lime-600 hover:cursor-pointer hover:bg-green-100"
                        >
                        🎁 Make It a Giveaway 🎁
                            </button>
                            {/if}
                        </div>

                        <div class="pt-3 w-full">
                             <button    
                                 onclick={() => {createRaffle(iotaClient, activeWallet, activeWalletAccount, newRaffleInitialLiquidityNanos, newRaffleTicketPriceNanos, newRaffleDurationSec, newRaffleIsGiveaway, newRaffleUrl); delayedRenewState()}}
                                 class="w-full h-16 bg-indigo-600 hover:bg-indigo-700 text-white text-xl font-bold py-2 px-6 rounded transition duration-150 ease-in-out disabled:opacity-50 disabled:cursor-not-allowed hover:cursor-pointer"
                                 disabled={!activeWalletAccount}
                             >
                             {#if newRaffleIsGiveaway}
                             ✨ Create Giveaway ✨
                             {:else}
                             ✨ Create Raffle ✨
                             {/if}
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
                        Raffles
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
                                <div class="border-2 border-amber-400 bg-gradient-to-tr from-amber-200 to-red-400 rounded-lg p-6 shadow-xl transition-shadow hover:shadow-md">
                                    <div class="flex justify-between items-start mb-1">
                                        <a href={getObjectExplorerUrl(explorerUrl, raffle.id)} target="_blank" rel="noopener noreferrer" class="text-sm font-mono text-slate-600 hover:underline break-all pr-4" title={`Raffle ID: ${raffle.id}`}>
                                             {shortenHex(raffle.id, 4)}
                                        </a>
                                        {#if raffle.prize_money == 0 && raffle.winning_ticket != null}
                                             <span class="text-xs sm:text-base font-semibold bg-gray-400 text-white px-2 py-0.5 rounded-full whitespace-nowrap">Completed</span>
                                         {:else if raffle.winning_ticket != null}
                                             <span class="text-xs sm:text-base font-semibold bg-green-600 text-white px-2 py-0.5 rounded-full whitespace-nowrap">Prize Ready to Claim</span>
                                        {:else if raffle.redemption_timestamp_ms - onChainClockTimestampMs <= 0}
                                            <span class="text-xs sm:text-base font-semibold bg-purple-500 text-white px-2 py-0.5 rounded-full whitespace-nowrap">Awaiting Resolution</span>
                                        {:else}
                                            <span class="text-xs sm:text-base font-semibold bg-blue-500 text-white px-2 py-0.5 rounded-full whitespace-nowrap">Active</span>
                                        {/if}
                                    </div>
                                    {#if raffle.url != ""}
                                    <div class="text-sm mb-3">
                                        🔗 <a href={raffle.url} class="hover:underline">{raffle.url}</a>
                                    </div>
                                    {/if}
                                    {#if ( !!activeWalletAccount && raffle.creator == activeWalletAccount.address)}
                                        <p class="font-bold text-lg text-red-500">Created by you</p>
                                    {/if}
                                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 mb-3 text-sm">
                                        <div class="flex flex-row sm:flex-col sm:justify-between pb-1 ">
                                            <p class="text-gray-800 text-2xl mr-2"><span class="font-bold">Prize Pool</span> </p>
                                            <p class="text-green-800 text-2xl sm:text-4xl">{roundFractional(nanosToIota(raffle.prize_money), 2)} IOTA</p>
                                        </div>
                                        <div class="flex flex-col justify-end">
                                            <p class="text-gray-800 text-lg"><span class="font-bold">Ticket Price</span> {nanosToIota(raffle.ticket_price)} IOTA</p>
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

                <section class=" p-6 mb-6 rounded-lg shadow-md border-4 border-lime-600 bg-green-100 flex flex-col">
                    <div class="flex justify-between items-center border-b pb-3 mb-5">
                        <h1 class="text-2xl font-semibold text-gray-800">
                            Giveaways
                        </h1>
                        <div class="flex items-center space-x-2">
                            <label for="showCompleted" class="text-sm text-gray-600 whitespace-nowrap">Show Completed:</label>
                            <input id="showCompleted" type="checkbox" bind:checked={showCompletedGiveaways} class="rounded border-gray-300 text-indigo-600 shadow-sm focus:border-indigo-300 focus:ring focus:ring-offset-0 focus:ring-indigo-200 focus:ring-opacity-50 h-4 w-4 cursor-pointer">
                        </div>
                    </div>
    
                    <div class="flex-grow min-h-0 overflow-y-auto max-h-[65vh] pr-2 space-y-4">
                         {#if allGiveaways.length === 0}
                            <p class="text-center text-gray-500 py-10">No active giveaways found.</p>
                         {:else}
                            {#each allGiveaways as raffle}
                                {#if (raffle.prize_money != 0 && (!raffle.winning_ticket || ownsTicket(raffle.winning_ticket))) || showCompletedGiveaways}
                                    <div class="border-2 border-amber-400 bg-gradient-to-tl from-blue-100 to-emerald-400 rounded-lg p-6 shadow-xl transition-shadow hover:shadow-md">
                                        <div class="flex justify-between items-start mb-1">
                                            <a href={getObjectExplorerUrl(explorerUrl, raffle.id)} target="_blank" rel="noopener noreferrer" class="text-xs sm:text-sm font-mono text-slate-600 hover:underline break-all pr-4" title={`Raffle ID: ${raffle.id}`}>
                                                 {shortenHex(raffle.id, 4)}
                                            </a>
                                            {#if raffle.prize_money == 0 && raffle.winning_ticket != null}
                                                 <span class="text-xs sm:text-base font-semibold bg-gray-400 text-white px-2 py-0.5 rounded-xl whitespace-nowrap">Completed</span>
                                             {:else if raffle.winning_ticket != null}
                                                 <span class="text-xs sm:text-base font-semibold bg-green-600 text-white px-2 py-0.5 rounded-xl whitespace-nowrap">Prize Ready to Claim</span>
                                            {:else if raffle.redemption_timestamp_ms - onChainClockTimestampMs <= 0}
                                                <span class="text-xs sm:text-base font-semibold bg-purple-500 text-white px-2 py-0.5 rounded-xl whitespace-nowrap">Awaiting Resolution</span>
                                            {:else}
                                                <span class="text-xs sm:text-base font-semibold bg-blue-500 text-white px-2 py-0.5 rounded-xl whitespace-nowrap">Active</span>
                                            {/if}
                                        </div>
                                        {#if ( !!activeWalletAccount && raffle.creator == activeWalletAccount.address)}
                                        <p class="font-bold text-lg text-red-500">Created by you</p>
                                        {/if}
                                        {#if raffle.url != ""}
                                        <div class="text-sm mb-3">
                                            🔗 <a href={raffle.url} class="hover:underline">{raffle.url}</a>
                                        </div>
                                        {/if}
                                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 mb-3 text-sm">
                                            <div class="flex flex-row sm:flex-col sm:justify-between pb-1 ">
                                                <p class="text-gray-800 text-2xl mr-2"><span class="font-bold">Prize Pool</span> </p>
                                                <p class="text-green-800 text-2xl sm:text-4xl">{roundFractional(nanosToIota(raffle.prize_money), 2)} IOTA</p>
                                            </div>
                                            <div class="flex flex-col justify-end">
                                                <p class="text-gray-800"><span class="font-bold">Participants:</span> {raffle.tickets_sold}</p>
                                                {#if raffle.winning_ticket == null && raffle.redemption_timestamp_ms - onChainClockTimestampMs > 0}
                                                <p class="text-gray-800"><span class="font-bold">Ends in:</span> <span class="font-semibold text-blue-700">{timeHumanReadable(raffle.redemption_timestamp_ms - onChainClockTimestampMs)}</span></p>
                                               {:else if raffle.winning_ticket != null}
                                                   <p class="text-gray-800 col-span-1 sm:col-span-2"><span class="font-bold">Winning Ticket:</span> {shortenHex(raffle.winning_ticket, 4)}</p>
                                                {/if}
                                            </div>
                                        </div>
    
                                        <div class="flex flex-wrap items-center pt-3 border-t border-amber-200 mt-3">
                                            {#if ( !!activeWalletAccount && raffle.winning_ticket == null && raffle.creator == activeWalletAccount.address)}
                                            <label for="enterIntoGiveawayAddress" class="block text-md text-gray-700 text-sm sm:text-md">Address For New Participant:</label>
                                            <input id="enterIntoGiveawayAddress" bind:value={raffle.send_ticket_to}
                                                lang="en" required
                                                class="mt-1 mb-2 block w-full rounded-md border-2 shadow-sm bg-white hover:bg-green-100 border-green-500 sm:text-sm p-2"
                                                >
                                                <button
                                                    onclick={()=>{enterIntoGiveaway(iotaClient, activeWallet, activeWalletAccount, raffle.id, raffle.send_ticket_to); delayedRenewState()}}
                                                    disabled={!activeWalletAccount || raffle.ticket_price > activeWalletAccountBalance}
                                                    class="w-full bg-green-500 hover:bg-green-600 text-white mb-1 text-sm sm:text-md font-semibold py-1.5 px-3 rounded shadow-sm transition duration-150 ease-in-out cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                                >
                                                📝 Add Participant 📝
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
                                                🏁 Resolve Giveaway 🏁
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
            <p class="mb-4">You can buy tickets for a raffle until its resolution time. It then needs to be resolved, which will select a winning ticket at random. If you own the winning ticket, it will show at the top of the raffle list, and you can claim the prize money. </p>
            <h1 class="font-bold text-xl mb-2">Giveaways</h1>
            <p class="mb-4">Giveaways are raffles for which you can't buy tickets. As a giveaway creator, you can create tickets for as many addresses as you'd like.</p>
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