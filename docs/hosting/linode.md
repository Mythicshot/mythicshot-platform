# Host on Akamai Cloud (Linode)

> [!WARNING]
> Draft: Not yet verified on a real account. This guide is written from Akamai Cloud's documentation and from the code in this repository, and has not yet been run on a real Akamai Cloud account. Where a label in the control panel could not be confirmed, the guide says what to achieve and that the label may differ.

> [!NOTE]
> The software is not public yet: there is no published image and no public repository. You need a copy of this repository from the owner, and a computer with Docker to build the image from it, as [step 4 of the Docker runbook](../runbook-docker.md#4-build-the-app-image-and-copy-it-to-the-server) describes.

This guide takes you from no hosting to a running platform on one Linode (Akamai Cloud's name for a rented server; Akamai bought Linode and still uses the name). The install itself is the [Docker runbook](../runbook-docker.md); this guide adds the Akamai Cloud steps around it.

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
2. An Akamai Cloud (Linode) account with a payment method. You create it yourself; this guide does not cover sign-up.
3. A copy of this repository, from the owner.
4. A computer with Docker, to build the app image. [Get Docker](https://docs.docker.com/get-started/get-docker/) has the installers for Windows, macOS and Linux.
5. A terminal with `ssh` and `scp`. Windows 10 and 11, macOS and Linux all have them.

Prices checked 2026-11-17, in US dollars before tax. Akamai's pricing web page did not show its plan table to us, so the plan and backup prices below were read from [Akamai's public list of plans](https://api.linode.com/v4/linode/types), the same list the control panel uses.

| What | Price | Note |
|---|---|---|
| Nanode 1 GB (shared CPU) | [$5 a month, or $0.0075 an hour](https://api.linode.com/v4/linode/types) | 1 vCPU, 1 GB memory, 25 GB disk, 1,000 GB transfer, with a public IPv4 address |
| Backups service, optional | [$2 a month on this plan](https://api.linode.com/v4/linode/types) | [Daily, weekly and biweekly backups plus one manual snapshot](https://techdocs.akamai.com/cloud-computing/docs/backup-service) |
| Cloud Firewall, optional | [No additional charge](https://techdocs.akamai.com/cloud-computing/docs/cloud-firewall) | |

> [!WARNING]
> A Linode that is powered off is still billed. [Akamai's billing page](https://techdocs.akamai.com/cloud-computing/docs/understanding-how-billing-works) says charges accrue for any service on the account, even powered off, until you remove it.

## 2. Create the server

The labels below are the ones [Akamai's "Create a Linode" page](https://techdocs.akamai.com/cloud-computing/docs/create-a-compute-instance) uses.

1. Log in to Cloud Manager, open the **Create** menu on the top bar and choose **Linode**.
2. Select the **region** closest to you and your visitors.
3. Under the image choice, stay on **Distributions** and pick Debian 13. [Akamai's public image list](https://api.linode.com/v4/images?page_size=200) has "Debian 13" and "Debian 12" as available; Debian 13 is the one to pick.
4. Under the plan choice, pick the shared CPU plan named Nanode 1 GB, at [$5 a month](https://api.linode.com/v4/linode/types). The name of the tab it sits under may differ.
5. Leave **Automated VM Backups** unticked for now, or tick it if you want Akamai's backups from the start ([step 8](#8-backups)).
6. Give the Linode a **Label** you will recognise, such as `tours`.
7. Under security, press **Add an SSH Key** and add your public key. A key is safer than a password. If the form insists on a **Root Password** as well, choose a long one and keep it in a password manager.
8. Under networking, keep the default **Public Internet** interface with an auto-assigned address. Keep whichever interface type the form has selected.
9. Under the firewall choice, decide as [step 3](#3-open-ports-80-and-443) explains.
10. Check the **Linode Summary** and press **Create Linode**.

**How to tell it worked:** after a few minutes the Linode's page shows it running, with its IPv4 address. Write it down: it is the `203.0.113.10` of this guide. The same page shows the IPv6 address every Linode gets.

## 3. Open ports 80 and 443

The platform needs these ports open from the internet.

| Port | Protocol | Why |
|---|---|---|
| 80 | TCP | The certificate authority checks the server here |
| 443 | TCP | HTTPS |
| 443 | UDP | HTTP/3, optional |

Akamai's control-panel firewall is called a Cloud Firewall. It is [free](https://techdocs.akamai.com/cloud-computing/docs/cloud-firewall), and the create form asks about it: you can pick a firewall, create one, or choose **No firewall - traffic is unprotected (not recommended)**, as [the create page](https://techdocs.akamai.com/cloud-computing/docs/create-a-compute-instance) words it.

**If you choose no firewall,** nothing in the control panel stands between the internet and the server, and there is nothing to do in this step.

**If you create or pick one,** its [default inbound policy is Drop](https://techdocs.akamai.com/cloud-computing/docs/create-a-cloud-firewall): it blocks all inbound traffic that no rule allows. The ready-made rule set for a public interface [allows SSH and essential network control traffic only](https://techdocs.akamai.com/cloud-computing/docs/cloud-firewall), so add the two web ports, with the labels from [Akamai's firewall rules page](https://techdocs.akamai.com/cloud-computing/docs/manage-firewall-rules):

1. In Cloud Manager, select **Firewalls** from the navigation menu and click your firewall. This opens its **Rules** page.
2. Leave **Inbound Policy** on **Drop** and **Outbound Policy** on **Accept**.
3. Click **Add an Inbound Rule**.
4. Use the **Preset** for HTTP if the list has one. Otherwise give the rule a **Label**, set **Protocol** to TCP and **Ports** to 80, and allow all IPv4 and all IPv6 sources.
5. Add a second rule the same way for HTTPS, TCP port 443.
6. Save the changes. The name of the save button could not be confirmed and may differ.
7. Keep a rule that allows SSH on port 22, or you lock yourself out.

> [!WARNING]
> A firewall on the server itself does not protect these ports: Docker's page warns that ports a container publishes bypass such rules. See [step 3 of the runbook](../runbook-docker.md#3-open-ports-80-and-443).

## 4. Point the domain at the server

Do this at the company that runs your domain's DNS. The words differ a little between companies, but every one has a page to add DNS records.

1. Find that page. It is often called DNS, DNS records, Zone editor or Advanced DNS.
2. Add a record with these values. If the form wants the full name, type `tours.example.com` with your own domain.

| Type | Name (also called Host) | Value (also called Points to) | TTL |
|---|---|---|---|
| A | `tours` | `203.0.113.10`, the server's IPv4 address | leave the default |

3. Every Linode [gets one IPv6 address](https://techdocs.akamai.com/cloud-computing/docs/an-overview-of-ipv6-on-linode). You may also add an AAAA record with the same name and that address, such as `2001:db8::10`, if nothing blocks ports 80 and 443 over IPv6. If you are not sure, add none: the platform works over IPv4 alone.
4. Save the record.

> [!WARNING]
> Add an AAAA record only if ports 80 and 443 are open over IPv6 too. A wrong AAAA record can stop the HTTPS certificate from being issued.

**How to tell it worked:** after [step 5](#5-connect-by-ssh), this command on the server prints the address you entered. A new record can take a few minutes to show up.

```sh
getent ahosts tours.example.com
```

## 5. Connect by SSH

1. On the Linode's page in Cloud Manager, find the **SSH Access** field in the **Access** section and copy the command. [Akamai's setup page](https://techdocs.akamai.com/cloud-computing/docs/set-up-and-secure-a-compute-instance) shows it in this shape.

```sh
ssh root@203.0.113.10
```

2. Paste it into a terminal on your computer. The first time, the terminal asks whether you are sure you want to continue connecting. Type `yes`.

You are logged in as root, so the commands in this guide have no `sudo` in front.

**How to tell it worked:** this prints a line naming Debian GNU/Linux 13 (trixie).

```sh
grep PRETTY_NAME /etc/os-release
```

## 6. Install the platform

These are steps 4 and 5 of the [Docker runbook](../runbook-docker.md#4-build-the-app-image-and-copy-it-to-the-server), with the Akamai Cloud login filled in. The runbook explains each step, every question the script asks and every message it can print.

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

**Akamai's Backups service** is an extra, not a replacement. It costs [$2 a month on this plan](https://api.linode.com/v4/linode/types) and keeps [up to four backups: daily, weekly, biweekly and one manual snapshot](https://techdocs.akamai.com/cloud-computing/docs/backup-service). Turn it on with **Automated VM Backups** when creating the Linode, or later as [Akamai's "Enable backups" page](https://techdocs.akamai.com/cloud-computing/docs/enable-backups) shows. It copies the whole disk while the database is in use, so restore from the platform's archive when you can.

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

**Debian.** Keeping the server patched is yours to do. Run these now and then, and restart the server from Akamai Cloud's control panel when a new kernel was installed.

```sh
apt-get update
```

```sh
apt-get upgrade
```

The [runbook's update step](../runbook-docker.md#8-update) has the details.

## 10. Delete everything to stop paying

1. Make a backup and copy it off the server first, as in [step 8](#8-backups). After the next steps the data is gone.
2. In Cloud Manager, select **Linodes** from the sidebar and find your Linode. These labels are from [Akamai's "Stop further billing" page](https://techdocs.akamai.com/cloud-computing/docs/stop-further-billing).
3. Open its **...** menu and choose **Delete**.
4. Press **Delete Linode** in the confirmation box.
5. If you created a Cloud Firewall, delete it too. It costs nothing, but it no longer protects anything.

> [!WARNING]
> Deleting a Linode makes its data irretrievable, and Akamai's page says its Backups service and backup snapshots are deleted with it. Copy your own backup off the server first.

Last, remove the A record (and the AAAA record) for `tours.example.com` at your DNS company, so the name no longer points at an address that is not yours.

## Pages this guide relies on

Opened on 2026-11-17.

- [Akamai's public list of plans](https://api.linode.com/v4/linode/types) and [public list of images](https://api.linode.com/v4/images?page_size=200), for the plan, its price, the backup price and the Debian 13 image. Both are plain data pages that need no account.
- [Create a Linode](https://techdocs.akamai.com/cloud-computing/docs/create-a-compute-instance), for the labels in step 2.
- [Cloud Firewall](https://techdocs.akamai.com/cloud-computing/docs/cloud-firewall), [Create a Cloud Firewall](https://techdocs.akamai.com/cloud-computing/docs/create-a-cloud-firewall) and [Manage firewall rules](https://techdocs.akamai.com/cloud-computing/docs/manage-firewall-rules), for step 3.
- [An overview of IPv6 on Linode](https://techdocs.akamai.com/cloud-computing/docs/an-overview-of-ipv6-on-linode), for step 4.
- [Set up and secure a Linode](https://techdocs.akamai.com/cloud-computing/docs/set-up-and-secure-a-compute-instance), for step 5.
- [Backups](https://techdocs.akamai.com/cloud-computing/docs/backup-service) and [Enable backups](https://techdocs.akamai.com/cloud-computing/docs/enable-backups), for step 8.
- [Billing overview](https://techdocs.akamai.com/cloud-computing/docs/understanding-how-billing-works) and [Stop further billing](https://techdocs.akamai.com/cloud-computing/docs/stop-further-billing), for the cost warning and step 10.
- [Docker runbook](../runbook-docker.md) in this repository, for the install, the wizard, backups, updates and troubleshooting.
