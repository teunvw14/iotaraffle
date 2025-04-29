// util.ts

export function nanosToIota(amount: number): number {
    return amount / 1_000_000_000;
}

export function shortenHex(hex: string) {
    return hex.slice(0, 7) + "..." + hex.slice(-5, -1)
}

export function timeHumanReadable(miliseconds: number) {
    if (miliseconds < 0) {
        return 'Ready to resolve!';
    }
    let seconds = Math.floor(miliseconds / 1000);
    var levels = [
        [Math.floor(seconds / 31536000), 'years'],
        [Math.floor((seconds % 31536000) / 86400), 'days'],
        [Math.floor(((seconds % 31536000) % 86400) / 3600), 'hours'],
        [Math.floor((((seconds % 31536000) % 86400) % 3600) / 60), 'minutes'],
        [(((seconds % 31536000) % 86400) % 3600) % 60, 'seconds'],
    ];
    var returntext = 'Resolvable in';

    for (var i = 0, max = levels.length; i < max; i++) {
        if ( levels[i][0] === 0 ) continue;
        returntext += ' ' + levels[i][0] + ' ' + (levels[i][0] === 1 ? levels[i][1].substr(0, levels[i][1].length-1): levels[i][1]);
    };
    return returntext.trim();
}