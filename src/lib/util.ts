// util.ts

export function getObjectExplorerUrl(explorerUrl: string, id: string) {
    return explorerUrl + "/object/" + id
}

export function nanosToIota(amount: number): number {
    return amount / 1_000_000_000;
}

export function shortenHex(hex: string, visibleChars: number) {
    return hex.slice(0, 2+visibleChars) + "..." + hex.slice(-(visibleChars+1), -1)
}

export function timeHumanReadable(miliseconds: number) {
    let returntext = '';
    let seconds = Math.floor(miliseconds / 1000);
    var levels = [
        [Math.floor(seconds / 31536000), 'years'],
        [Math.floor((seconds % 31536000) / 86400), 'days'],
        [Math.floor(((seconds % 31536000) % 86400) / 3600), 'hours'],
        [Math.floor((((seconds % 31536000) % 86400) % 3600) / 60), 'minutes'],
        [(((seconds % 31536000) % 86400) % 3600) % 60, 'seconds'],
    ];

    for (var i = 0, max = levels.length; i < max; i++) {
        if ( levels[i][0] === 0 ) continue;
        returntext += ' ' + levels[i][0] + ' ' + (levels[i][0] === 1 ? levels[i][1].substr(0, levels[i][1].length-1): levels[i][1]);
    };
    return returntext.trim();
}

export function roundFractional(num: number, decimals: number) {
    return Math.round(num * Math.pow(10, decimals)) / Math.pow(10, decimals);
}