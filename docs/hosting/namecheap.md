# Host on a Namecheap VPS

> [!WARNING]
> Draft: Not yet verified on a real account. This guide is written from Namecheap's documentation and from the code in this repository, and has not yet been run on a real Namecheap account. Where a label in the control panel could not be confirmed, the guide says what to achieve and that the label may differ.

> [!NOTE]
> The software is not public yet: there is no published image and no public repository. You need a copy of this repository from the owner, and a computer with Docker to build the image from it, as [step 4 of the Docker runbook](../runbook-docker.md#4-build-the-app-image-and-copy-it-to-the-server) describes.

This guide takes you from no hosting to a running platform on one Namecheap VPS (a rented virtual server). It suits you best if your domain is registered at Namecheap already, because one account then holds both. The install itself is the [Docker runbook](../runbook-docker.md); this guide adds the Namecheap steps around it.

Examples use `tours.example.com` for the platform's address, `203.0.113.10` for the server's IPv4 address and `2001:db8::10` for its IPv6 address. Put your own in their place.

## Contents

- [1. What you need and what it costs](#1-what-you-need-and-what-it-costs)
- [2. Create the server](#2-create-the-server)
- [3. Open ports 80 and 443](#3-open-ports-80-and-443)
- [4. Point the domain at the server](#4-point-the-domain-at-the-server)
- [5. Connect by SSH](#5-connect-by-ssh)
- [6. Install the platform](#6-install-the-platform)
- [7. Open the setup wizard](#7-open-the-setup-wizard)
- [8. Backups](#8-backups)
- [9. Updates](#9-updates)
- [10. Delete everything to stop paying](#10-delete-everything-to-stop-paying)
- [Pages this guide relies on](#pages-this-guide-relies-on)

## 1. What you need and what it costs

1. A domain name, and a login at the company that runs its DNS. This is usually where you bought the domain.
2. A Namecheap account with a payment method. You create it yourself; this guide does not cover sign-up.
3. A copy of this repository, from the owner.
4. A computer with Docker, to build the app image. [Get Docker](https://docs.docker.com/get-started/get-docker/) has the installers for Windows, macOS and Linux.
5. A terminal with `ssh` and `scp`. Windows 10 and 11, macOS and Linux all have them.

Prices checked 2026-11-17 on [Namecheap's VPS page](https://www.namecheap.com/hosting/vps/), in US dollars before tax. The plan that fits is the smallest one, Spark.

| What | Price | Note |
|---|---|---|
| Spark, billed yearly | [$3.88 a month](https://www.namecheap.com/hosting/vps/) | $46.56 paid up front (our arithmetic). The page shows "Was $4.88/mo" |
| Spark, billed quarterly | [$4.48 a month](https://www.namecheap.com/hosting/vps/) | $13.44 paid every three months (our arithmetic). The page shows "Was $5.48/mo" |
| Spark, billed monthly | [$4.88 a month](https://www.namecheap.com/hosting/vps/) | The page shows "Was $5.88/mo" |
| What Spark includes | [1 CPU core, 1 GB RAM, 20 GB SSD, 1000 GB bandwidth a month, 1 IPv4 address, root access](https://www.namecheap.com/hosting/vps/) | |
| Server management | [User-responsible: free, and the default](https://www.namecheap.com/hosting/vps/) | You look after the server yourself, which is what this guide assumes |
| Domain name | [Free for 1 year with the plan](https://www.namecheap.com/hosting/vps/) | **Unconfirmed:** which endings qualify and what the domain costs after the first year |
| Control panel (cPanel or Webuzo) | Not needed. Do not order one | [Webuzo starts at $2.88 a month and cPanel at $17.88 a month](https://www.namecheap.com/hosting/vps/) |

Namecheap's page also promises a [30-day money-back guarantee](https://www.namecheap.com/hosting/vps/).

> [!WARNING]
> The lowest price is a prepaid term: a year or a quarter is charged at once. **Unconfirmed:** the page does not say what a renewal costs. Expect the crossed-out "Was" price or more, and read the renewal price in the cart before you pay. The free domain is free for one year only and then renews at a paid price.

> [!WARNING]
> Shutting the server down does not stop the bill. The term is prepaid, and the plan renews unless its auto-renew option is off; [step 10](#10-delete-everything-to-stop-paying) shows where that option is.

## 2. Create the server

The steps follow [Namecheap's VPS setup guide](https://www.namecheap.com/support/knowledgebase/article.aspx/10777/48/how-to-set-up-a-vps-beginnerfriendly-stepbystep-guide/). Its screenshots could not be read, so some labels may differ.

1. Open [Namecheap's VPS page](https://www.namecheap.com/hosting/vps/). On the Spark plan, choose the billing cycle (monthly, quarterly or yearly) and start the order. The guide calls the button **Get Started**; the page today shows **Buy now**.
2. On the **Hosting Configuration** page, keep the Spark plan as it is. Do not add RAM, CPU or disk.
3. For **Server Management**, keep the free User-responsible option.
4. For **Web Panel**, choose none. The platform brings its own web server, which needs ports 80 and 443 for itself, and a control panel's web server would be in the way. Namecheap's guide says cPanel and Webuzo cannot be used with Spark anyway.
5. For **Operating System**, choose Debian 12. [Namecheap's list of operating systems](https://www.namecheap.com/support/knowledgebase/article.aspx/9979/2188/what-operating-systems-are-available-with-a-vpsdedicated-server/) names "Debian 12 Blank 64 Bit" and Debian 11; Debian 13 is not on it. "Blank" means no control panel. The install script accepts Debian 12 and prints a notice.
6. Go to the next step. The **Domain Name Connection** page asks which domain goes with the server. Pick the domain you own, or the free new one. **Unconfirmed:** what this page changes in the domain's DNS. The record you create in [step 4](#4-point-the-domain-at-the-server) is what counts.
7. Add the order to the cart, read the total and the renewal price, and pay.
8. Wait for the **Hosting Welcome Email**. Namecheap's guide says it holds the service's login details, settings and instructions. Check the spam folder too.

> [!WARNING]
> The welcome email holds the server's root password. Move the password into a password manager and do not forward the email.

**How to tell it worked:** in your Namecheap account, **Hosting List**, then **Manage** next to the VPS, shows the service's details. Write down the server's IP address, from there or from the welcome email: it is the `203.0.113.10` of this guide.

## 3. Open ports 80 and 443

The platform needs these ports open from the internet.

| Port | Protocol | Why |
|---|---|---|
| 80 | TCP | The certificate authority checks the server here |
| 443 | TCP | HTTPS |
| 443 | UDP | HTTP/3, optional |

**Unconfirmed:** we found no Namecheap page that describes a firewall in front of a VPS that you manage in the control panel. [Namecheap's VPS page](https://www.namecheap.com/hosting/vps/) mentions "software firewalls" without saying where they are or what they block, and [its setup guide](https://www.namecheap.com/support/knowledgebase/article.aspx/10777/48/how-to-set-up-a-vps-beginnerfriendly-stepbystep-guide/) only shows a firewall you install on the server yourself. So this guide assumes nothing outside the server blocks ports 80 and 443, and there is nothing to do in this step.

Because that is an assumption, test it: at the end of [step 7](#7-open-the-setup-wizard), run the check from another network, such as a phone that is off Wi-Fi. If it fails there while the name points at the right address, ask Namecheap's support whether ports 80 and 443 are blocked before the server.

Namecheap's setup guide has you install a firewall called UFW on the server. You do not need it for the platform. If you turn it on anyway, allow ports 22, 80 and 443 first, as that guide shows, or you lock yourself out.

> [!WARNING]
> A firewall on the server itself does not protect these ports: Docker's page warns that ports a container publishes bypass such rules. See [step 3 of the runbook](../runbook-docker.md#3-open-ports-80-and-443).

## 4. Point the domain at the server

Do this at the company that runs your domain's DNS. The words differ a little between companies, but every one has a page to add DNS records.

1. Find that page. It is often called DNS, DNS records, Zone editor or Advanced DNS.
2. Add a record with these values. If the form wants the full name, type `tours.example.com` with your own domain.

| Type | Name (also called Host) | Value (also called Points to) | TTL |
|---|---|---|---|
| A | `tours` | `203.0.113.10`, the server's IPv4 address | leave the default |

3. Add no AAAA record. Namecheap's page lists one IPv4 address for this plan and no IPv6 address.
4. Save the record.

> [!WARNING]
> Add an AAAA record only if ports 80 and 443 are open over IPv6 too. A wrong AAAA record can stop the HTTPS certificate from being issued.

### If the domain is registered at Namecheap

These are the same record, with the labels from [Namecheap's own how-to for A records](https://www.namecheap.com/support/knowledgebase/article.aspx/319/2237/how-can-i-set-up-an-a-address-record-for-my-domain/). It works when the domain uses Namecheap's BasicDNS, PremiumDNS or FreeDNS.

1. Sign in to your Namecheap account and select **Domain List** from the left sidebar.
2. Click **Manage** next to your domain.
3. Open the **Advanced DNS** tab.
4. In the **Host records** section, click **Add New Record**.
5. Select **A Record** for the type, enter `tours` as the **Host**, and enter the server's IPv4 address as the value. Leave the TTL on Automatic.
6. Save with the green **Save changes** icon.
7. Look for other records with the host `tours` (a redirect, another A record or a CNAME) and remove them. Namecheap's page says conflicting records for the same host should be removed.

Namecheap's page says a new record normally takes about 30 minutes to take effect.

**How to tell it worked:** after [step 5](#5-connect-by-ssh), this command on the server prints the address you entered. A new record can take a few minutes to show up.

```sh
getent ahosts tours.example.com
```

## 5. Connect by SSH

[Namecheap's setup guide](https://www.namecheap.com/support/knowledgebase/article.aspx/10777/48/how-to-set-up-a-vps-beginnerfriendly-stepbystep-guide/) says you log in as `root`, with the password from the welcome email, on port 22 for a User-responsible VPS. **Unconfirmed:** whether the order form can take an SSH key instead; the guide only describes the password.

1. On your computer, open a terminal and connect. On Windows, PowerShell has `ssh` too.

```sh
ssh root@203.0.113.10
```

2. The first time, the terminal asks whether you are sure you want to continue connecting. Type `yes`.
3. Enter the root password. Nothing shows while you type; that is normal.

You are logged in as root, so the commands in this guide have no `sudo` in front.

If the password is lost, Namecheap's guide says the **Go to VPS Panel** button on the service's **Manage** page opens the panel where the server is managed. **Unconfirmed:** the exact steps to reset the password there.

**How to tell it worked:** this prints a line naming Debian GNU/Linux 12 (bookworm).

```sh
grep PRETTY_NAME /etc/os-release
```

## 6. Install the platform

These are steps 4 and 5 of the [Docker runbook](../runbook-docker.md#4-build-the-app-image-and-copy-it-to-the-server), with the Namecheap login filled in. The runbook explains each step, every question the script asks and every message it can print.

1. On the server, find its architecture. This prints `amd64` or `arm64`.

```sh
dpkg --print-architecture
```

2. On your computer, in the folder holding the repository, build the image. Use this when your computer has the same architecture as the server.

```sh
docker build -t demo-platform:latest .
```

When it differs, for example an Apple-silicon Mac and an `amd64` server, build for the server instead. The runbook marks this as unconfirmed, because it needs your Docker to be set up for it.

```sh
docker buildx build --platform linux/amd64 --load -t demo-platform:latest .
```

3. Save the image to a file.

```sh
docker save -o demo-platform.tar demo-platform:latest
```

4. Copy the image file and the install script to the server.

```sh
scp demo-platform.tar deploy/install.sh root@203.0.113.10:
```

5. On the server, read the script before you run it as root.

```sh
less install.sh
```

6. Run it once. It asks for the domain name (`tours.example.com`), an email address for the certificate, and the data folder (press Enter). It installs Docker and then stops, saying the app image is not on this server. That is expected.

```sh
bash install.sh
```

7. Load the image you copied.

```sh
docker load -i demo-platform.tar
```

8. Run the script again. This time it starts the platform.

```sh
bash install.sh
```

At the end it prints the address and the setup code. This is the only time the code is printed.

> [!WARNING]
> Whoever enters the setup code first becomes the owner of the platform. Keep it private until you finish [step 7](#7-open-the-setup-wizard).

**How to tell it worked:** this shows both containers running and the app `healthy`.

```sh
bash install.sh status
```

## 7. Open the setup wizard

1. Open `https://tours.example.com/setup` in a browser.
2. Enter the setup code the script printed.
3. Enter a workspace name and the owner's email address.
4. Copy the API token into your password manager. It is shown once.
5. In Mythicshot, open Settings › Output › Tour publishing, paste the server address and the token, and press Test connection.

The [runbook's wizard step](../runbook-docker.md#7-the-setup-wizard-and-mythicshot) covers each screen, and what to do if the code or the token is lost.

> [!WARNING]
> The API token works like a password: anyone holding it can upload to and unpublish every tour in the workspace.

**How to tell it worked:** from your computer, this prints `{"ok":true}` without a certificate error. If the browser shows a certificate error instead, go back to [step 3](#3-open-ports-80-and-443) and [step 4](#4-point-the-domain-at-the-server).

```sh
curl https://tours.example.com/healthz
```

## 8. Backups

The platform's own backup is the one to rely on. It works the same at every provider.

1. On the server, write a backup archive. It lands in `/opt/demo-platform/backups`.

```sh
bash install.sh backup
```

2. Copy the archive to your own computer, as [step 9 of the runbook](../runbook-docker.md#9-back-up-and-restore) shows. The same section has the restore steps.

> [!WARNING]
> A backup that stays on the server is lost with the server. Copy every archive somewhere else, and keep it as private as a password: it holds the owner's email, the token hashes and every draft image.

**Namecheap's own backups** are not something to plan on. [Its setup guide](https://www.namecheap.com/support/knowledgebase/article.aspx/10777/48/how-to-set-up-a-vps-beginnerfriendly-stepbystep-guide/) says Namecheap makes regular backups internally and that you can ask for the latest one, and [its VPS page](https://www.namecheap.com/hosting/vps/) lists a flat $10.00 per restore after a server failure on the User-responsible option. **Unconfirmed:** how often those backups are made and how long they are kept.

## 9. Updates

**The platform.** There is no published image, so an update is a new image built from a newer copy of the repository.

1. On your computer, build and save the image again and copy it to the server, as in [step 6](#6-install-the-platform), items 2 to 4.
2. On the server, load it.

```sh
docker load -i demo-platform.tar
```

3. Run the update. It writes a backup first, then restarts on the new image.

```sh
bash install.sh update
```

**Debian.** Keeping the server patched is yours to do. Run these now and then, and restart the server from Namecheap's control panel when a new kernel was installed.

```sh
apt-get update
```

```sh
apt-get upgrade
```

The [runbook's update step](../runbook-docker.md#8-update) has the details.

## 10. Delete everything to stop paying

1. Make a backup and copy it off the server first, as in [step 8](#8-backups). After the next steps the data is gone.
2. In your Namecheap account, go to **Hosting List** and click **Manage** next to the VPS. These labels are from [Namecheap's "cancel my hosting" page](https://www.namecheap.com/support/knowledgebase/article.aspx/170/21/how-do-i-cancel-my-hosting-account/).
3. To stop the next charge and keep the server until the paid term ends, remove the checkmark from the auto-renew option. The page says the service is then suspended after its billing date and cancelled afterwards.
4. To end it now, click **Cancel service**, read and accept the terms, and click **Yes, cancel hosting**. Namecheap sends an email when the cancellation is done. **Unconfirmed:** whether any of the prepaid term is refunded outside the 30-day money-back guarantee.
5. The domain is separate. Namecheap's page says cancelling hosting does not cancel the domain registration. If you do not want to pay for the domain after its free year, turn off its auto-renew as well, in **Domain List**. The label there could not be confirmed.

> [!WARNING]
> Cancelling the service at once erases all its data immediately, as Namecheap's page words it, and that cannot be undone. Copy your own backup off the server first.

Last, remove the A record (and the AAAA record) for `tours.example.com` at your DNS company, so the name no longer points at an address that is not yours.

## Pages this guide relies on

Opened on 2026-11-17.

- [Namecheap VPS hosting](https://www.namecheap.com/hosting/vps/), for the plan, its three prices, what it includes, the management options and the control panel prices. Read in a browser; the page refuses plain automated requests.
- [How to set up a VPS](https://www.namecheap.com/support/knowledgebase/article.aspx/10777/48/how-to-set-up-a-vps-beginnerfriendly-stepbystep-guide/), for the order steps, the welcome email, the SSH login and the backups remark.
- [Operating systems available with a VPS](https://www.namecheap.com/support/knowledgebase/article.aspx/9979/2188/what-operating-systems-are-available-with-a-vpsdedicated-server/), for Debian 12.
- [How to set up an A record](https://www.namecheap.com/support/knowledgebase/article.aspx/319/2237/how-can-i-set-up-an-a-address-record-for-my-domain/), for step 4.
- [How do I cancel my hosting account?](https://www.namecheap.com/support/knowledgebase/article.aspx/170/21/how-do-i-cancel-my-hosting-account/), for step 10.
- [Docker runbook](../runbook-docker.md) in this repository, for the install, the wizard, backups, updates and troubleshooting.
