const path = require('path');

function titleFromPath(p) {
    const normalizedP = p.replace(/\\/g, "/");
    const base = path.basename(p, path.extname(p));
    if (/^(index|page)$/.test(base)) {
        const segments = normalizedP.split("/");
        for (let i = segments.length - 2; i >= 0; i--) {
            const seg = segments[i];
            if (!seg || /^\(.*\)$/.test(seg)) continue;
            if (seg === "app" || seg === "pages" || seg === "src") break;
            if (/^\[/.test(seg)) continue;
            return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/[-_]/g, " ");
        }
        return "Home";
    }
    const firstSeg = base.split(".").find((s) => s && !s.startsWith("$") && s !== "_index") || base;
    return firstSeg.replace(/[-_]/g, " ").replace(/\b(\w)/g, (c) => c.toUpperCase());
}

const testPaths = [
    "/repo/app/routes/appointments.$appointmentId.tsx",
    "/repo/app/routes/appointments._index.tsx",
    "/repo/app/routes/billing.$invoiceId.tsx",
    "/repo/app/routes/auth.login.tsx",
    "/repo/app/dashboard/projects/[id]/page.tsx",
    "/repo/app/dashboard/teams/[id]/page.tsx",
];

for (const p of testPaths) {
    console.log(p.split('/').pop(), '->', titleFromPath(p));
}
