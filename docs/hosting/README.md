# Hosting guides

> [!WARNING]
> Draft: Not yet verified on a real account. The provider guides in the table below are written from each provider's documentation and from the code in this repository, and nothing in them has been run on a real account yet. The [shared cPanel hosting guide](cpanel.md) is the one exception, and only in part: its first lines say what was run on real hosting and what was not.

> [!NOTE]
> There is no published image yet, so every guide starts from a copy of this repository. The server guides also need Docker on your own computer to build the image.

You own a domain and have no hosting yet. Pick one row, then follow its guide from top to bottom. Every guide uses `tours.example.com` where your own address goes.

Prices were checked 2026-11-17 on the pages each guide links. They are in US dollars, before tax, for the smallest setup that fits.

## Choose a provider

| Provider | Monthly cost | Effort | Best for |
|---|---|---|---|
| [DigitalOcean](digitalocean.md) | $6 | Medium: one server, SSH, one DNS record | A plain rented server with the fewest surprises |
| [Namecheap VPS](namecheap.md) | $3.88 billed yearly, $4.48 billed quarterly, $4.88 billed monthly | Medium: one server, SSH, one DNS record; the term is prepaid | Your domain is at Namecheap already and you want one account for both |
| [Akamai Cloud (Linode)](linode.md) | $5 | Medium: one server, SSH, one DNS record | The cheapest plain rented server of the four |
| [AWS Lightsail](aws-lightsail.md) | $7 | Medium: as above, plus one firewall rule and a static address | You want it inside your own AWS account at a flat price |
| [Azure virtual machine](azure.md) | About $13: the server, its disk and its address are billed separately | Medium to high: more choices in the portal, more lines on the bill | You want it inside your own Azure account |
| [Fly.io](fly.md) | About $3.84, and Fly waives a personal bill under $5 | Low to medium: no server to look after, but everything is typed as commands | You do not want to patch a server |

The two runbooks cover what the guides above build on:

| Runbook | Use it when |
|---|---|
| [Docker on Debian](../runbook-docker.md) | You already have a Debian server, at any provider or at home. The server guides above follow this runbook for the install itself. |
| [Cloudflare](../runbook-cloudflare.md) | Your domain is on Cloudflare, or you are willing to move it there. No server and no disk. |

One more route needs no server of your own and no Docker:

| Guide | Use it when |
|---|---|
| [Shared cPanel hosting](cpanel.md) | You already pay for shared hosting whose cPanel has "Setup Node.js App", with SSH access. The platform runs as a Node.js app in your hosting account, installed by a script from one archive. The guide names no prices. |

Every route above sets up one address. To give the app a second address beside the address of the tours, see [Two addresses](../runbook-docker.md#two-addresses) in the Docker runbook, which the server guides install through, or [A second address for the app](cpanel.md#14-a-second-address-for-the-app) in the cPanel guide. Neither has been run on real hosting yet, the per-provider guides do not change for it, and the Fly.io and Cloudflare routes do not have it yet.

## What every route has in common

1. You get a copy of this repository.
2. You create one hostname for the platform, such as `tours.example.com`, at the company that runs your domain's DNS.
3. You open `https://tours.example.com/setup` once, enter the setup code, and copy the API token into Mythicshot.
4. Backups kept somewhere else are yours to make. No route here makes them for you.

> [!WARNING]
> Every provider bills until you delete what you created, not until you stop it. Each guide ends with the steps to delete everything.

## How the server guides differ

| | DigitalOcean | Akamai Cloud | AWS Lightsail | Azure | Namecheap |
|---|---|---|---|---|---|
| Plan | Basic, 1 GiB | Nanode 1 GB | $7 Linux plan, 1 GB | B2ats v2, or B2pts v2 on Arm | Spark |
| Debian image | 13 | 13 | 13 | 12 | 12 |
| Login name | `root` | `root` | `admin` | the one you choose, such as `azureuser` | `root` |
| Control-panel firewall | None unless you create one | None unless you choose one | Always on: opens 22 and 80 only | Always on: opens only what you tick | None found in Namecheap's pages (unconfirmed) |
| What you must open | Nothing, or 80 and 443 if you add a firewall | Nothing, or 80 and 443 if you add a firewall | 443 | 80 and 443 | Nothing, as far as could be confirmed |

Each guide says where every row above comes from.
