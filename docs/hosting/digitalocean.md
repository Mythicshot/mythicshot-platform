# Host on DigitalOcean

> [!WARNING]
> Draft: Not yet verified on a real account. This guide is written from DigitalOcean's documentation and from the code in this repository, and has not yet been run on a real DigitalOcean account. Where a label in the control panel could not be confirmed, the guide says what to achieve and that the label may differ.

> [!NOTE]
> The software is not public yet: there is no published image and no public repository. You need a copy of this repository from the owner, and a computer with Docker to build the image from it, as [step 4 of the Docker runbook](../runbook-docker.md#4-build-the-app-image-and-copy-it-to-the-server) describes.

This guide takes you from no hosting to a running platform on one DigitalOcean Droplet (DigitalOcean's name for a rented server). The install itself is the [Docker runbook](../runbook-docker.md); this guide adds the DigitalOcean steps around it.

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
2. A DigitalOcean account with a payment method. You create it yourself; this guide does not cover sign-up.
3. A copy of this repository, from the owner.
4. A computer with Docker, to build the app image. [Get Docker](https://docs.docker.com/get-started/get-docker/) has the installers for Windows, macOS and Linux.
5. A terminal with `ssh` and `scp`. Windows 10 and 11, macOS and Linux all have them.

Prices checked 2026-11-17, in US dollars before tax.

| What | Price | Note |
|---|---|---|
| Droplet, Basic, Regular CPU, 1 GiB | [$6 a month, or $0.00893 an hour](https://www.digitalocean.com/pricing/droplets) | 1 vCPU, 1 GiB memory, 25 GiB SSD, 1,000 GiB transfer, with a public IPv4 address |
| Automated backups, optional | [20% of the Droplet's price weekly, 30% daily](https://docs.digitalocean.com/products/backups/details/pricing/) | $1.20 or $1.80 a month on this plan (our arithmetic) |
| Snapshots, optional | [$0.06 per GB a month](https://www.digitalocean.com/pricing/droplets) | |
| Transfer above the allowance | [$0.01 per GiB](https://docs.digitalocean.com/products/droplets/details/pricing/) | Unlikely at this size |
| Cloud firewall, optional | [No extra cost](https://docs.digitalocean.com/products/networking/firewalls/) | |

The [$4 plan](https://www.digitalocean.com/pricing/droplets) has 512 MiB of memory and a 10 GiB disk. It is too small for this guide.

> [!WARNING]
> A Droplet that is powered off is still billed. [DigitalOcean's pricing page](https://docs.digitalocean.com/products/droplets/details/pricing/) says billing stops only when you destroy it.

## 2. Create the server

The labels below are the ones [DigitalOcean's "create a Droplet" page](https://docs.digitalocean.com/products/droplets/how-to/create/) uses.

1. Sign in to the DigitalOcean control panel and open the **Create Droplet** page.
2. Under **Choose Region**, pick the datacenter closest to you and your visitors.
3. Under **Choose an image**, stay on the **OS** tab and pick Debian 13. [DigitalOcean's image list](https://docs.digitalocean.com/products/droplets/details/images/) names it "Debian 13 Image" (`debian-13-x64`), and it is the only Debian image listed there.
4. If the page asks for a configuration type, pick **Bundled**. That is the fixed-price plan.
5. Under **Choose Size**, pick **SHARED CPU**, then the Basic plan with a Regular CPU, 1 GiB of memory and a 25 GiB disk, at [$6 a month](https://www.digitalocean.com/pricing/droplets). The exact names of the tabs inside this section may differ.
6. Leave **Additional Storage** empty.
7. Under **Choose Authentication Method**, pick **SSH Key** and add your public key with **Add SSH Key**. A key is safer than a password. If you have no key yet, **Password** also works: choose a long one and keep it in a password manager.
8. Open **Additional Options**. Under **Networking**, keep **Public IPv4 address** ticked. Tick **Public IPv6 address** only if you want the platform reachable over IPv6 too.
9. Under **Finalize Details**, keep the quantity at 1 and give the Droplet a **Hostname** you will recognise, such as `tours`.
10. Press **Create Droplet**.

**How to tell it worked:** when the progress bar finishes, the control panel shows the Droplet with its IP address. Write it down: it is the `203.0.113.10` of this guide.

## 3. Open ports 80 and 443

The platform needs these ports open from the internet.

| Port | Protocol | Why |
|---|---|---|
| 80 | TCP | The certificate authority checks the server here |
| 443 | TCP | HTTPS |
| 443 | UDP | HTTP/3, optional |

DigitalOcean's control-panel firewall is called a cloud firewall. It is [free and optional](https://docs.digitalocean.com/products/networking/firewalls/): a Droplet is behind one only if you create one and apply it to the Droplet. The Droplet steps above do not create one.

**If you add no cloud firewall,** there is nothing to do in this step. We could not find a sentence on DigitalOcean's pages that says a Droplet without a cloud firewall accepts all traffic, so treat the check at the end of [step 7](#7-open-the-setup-wizard) as the proof.

**If you add one,** it [blocks everything a rule does not allow](https://docs.digitalocean.com/products/networking/firewalls/), and a new one [starts with only SSH on port 22 open for inbound traffic](https://docs.digitalocean.com/products/networking/firewalls/how-to/create/). Add the two web ports, with the labels from [DigitalOcean's rules page](https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/):

1. In the main menu, open **Networking**, then **Firewalls**, and click the firewall's name.
2. Under **Inbound rules**, press **Add inbound rule**.
3. In **Type**, choose **HTTP**. This fills in TCP and port 80. Leave **Sources** on **All IPv4** and **All IPv6**.
4. Press **Add inbound rule** to save it.
5. Do the same again with **HTTPS**, which is TCP port 443.
6. Keep the SSH rule, or you lock yourself out.

> [!WARNING]
> A firewall on the server itself does not protect these ports: Docker's page warns that ports a container publishes bypass such rules. See [step 3 of the runbook](../runbook-docker.md#3-open-ports-80-and-443).

## 4. Point the domain at the server

Do this at the company that runs your domain's DNS. The words differ a little between companies, but every one has a page to add DNS records.

1. Find that page. It is often called DNS, DNS records, Zone editor or Advanced DNS.
2. Add a record with these values. If the form wants the full name, type `tours.example.com` with your own domain.

| Type | Name (also called Host) | Value (also called Points to) | TTL |
|---|---|---|---|
| A | `tours` | `203.0.113.10`, the server's IPv4 address | leave the default |

3. If you ticked **Public IPv6 address** in step 2, you may also add an AAAA record with the same name and the Droplet's IPv6 address, such as `2001:db8::10`. Otherwise add none.
4. Save the record.

> [!WARNING]
> Add an AAAA record only if ports 80 and 443 are open over IPv6 too. A wrong AAAA record can stop the HTTPS certificate from being issued.

**How to tell it worked:** after [step 5](#5-connect-by-ssh), this command on the server prints the address you entered. A new record can take a few minutes to show up.

```sh
getent ahosts tours.example.com
```

## 5. Connect by SSH

[DigitalOcean's SSH page](https://docs.digitalocean.com/products/droplets/how-to/connect-with-ssh/) says the default username on a new Droplet is `root` on most operating systems. It does not name Debian, so if `root` is refused, check the Droplet's page in the control panel for the username.

1. On your computer, open a terminal and connect. The command has the shape [DigitalOcean's OpenSSH page](https://docs.digitalocean.com/products/droplets/how-to/connect-with-ssh/openssh/) gives.

```sh
ssh root@203.0.113.10
```

2. The first time, the terminal asks whether you are sure you want to continue connecting. Type `yes`.

You are logged in as root, so the commands in this guide have no `sudo` in front.

**How to tell it worked:** this prints a line naming Debian GNU/Linux 13 (trixie).

```sh
grep PRETTY_NAME /etc/os-release
```

## 6. Install the platform

These are steps 4 and 5 of the [Docker runbook](../runbook-docker.md#4-build-the-app-image-and-copy-it-to-the-server), with the DigitalOcean login filled in. The runbook explains each step, every question the script asks and every message it can print.

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

**DigitalOcean's own backups** are an extra, not a replacement. Automated backups cost [20% (weekly) or 30% (daily) of the Droplet's price](https://docs.digitalocean.com/products/backups/details/pricing/), and you can turn them on with **Enable automated backups** when creating the Droplet. They copy the whole disk while the database is in use, so restore from the platform's archive when you can.

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

**Debian.** Keeping the server patched is yours to do. Run these now and then, and restart the server from DigitalOcean's control panel when a new kernel was installed.

```sh
apt-get update
```

```sh
apt-get upgrade
```

The [runbook's update step](../runbook-docker.md#8-update) has the details.

## 10. Delete everything to stop paying

1. Make a backup and copy it off the server first, as in [step 8](#8-backups). After the next steps the data is gone.
2. In the control panel, click the Droplet's name, open the **Settings** tab and press **Destroy**. These labels are from [DigitalOcean's "destroy a Droplet" page](https://docs.digitalocean.com/products/droplets/how-to/destroy/).
3. In the **Droplet Danger Zone** window, open the **Destroy** tab.
4. Tick the boxes for any snapshots and volumes listed, so they are destroyed too. None are ticked by default, and what you leave [keeps being billed](https://docs.digitalocean.com/products/droplets/how-to/destroy/).
5. Type the Droplet's name to confirm and press **Destroy**.
6. If you created a cloud firewall, delete it too. It costs nothing, but it no longer protects anything.

> [!WARNING]
> Destroying a Droplet cannot be undone: DigitalOcean's page says it "permanently and irreversibly destroys the Droplet". Automated backups are not destroyed with it; they stay until their retention ends.

Last, remove the A record (and the AAAA record) for `tours.example.com` at your DNS company, so the name no longer points at an address that is not yours.

## Pages this guide relies on

Opened on 2026-11-17.

- [Droplet pricing](https://www.digitalocean.com/pricing/droplets), for the plan, its size and its price, and the snapshot price.
- [Droplet pricing details](https://docs.digitalocean.com/products/droplets/details/pricing/), for billing while powered off and the transfer price.
- [Droplet images](https://docs.digitalocean.com/products/droplets/details/images/), for the Debian 13 image.
- [How to create a Droplet](https://docs.digitalocean.com/products/droplets/how-to/create/), for the labels in step 2.
- [Cloud firewalls](https://docs.digitalocean.com/products/networking/firewalls/), [create a firewall](https://docs.digitalocean.com/products/networking/firewalls/how-to/create/) and [configure rules](https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/), for step 3.
- [Connect with SSH](https://docs.digitalocean.com/products/droplets/how-to/connect-with-ssh/) and [connect with OpenSSH](https://docs.digitalocean.com/products/droplets/how-to/connect-with-ssh/openssh/), for step 5.
- [Backups pricing](https://docs.digitalocean.com/products/backups/details/pricing/), for step 8.
- [How to destroy a Droplet](https://docs.digitalocean.com/products/droplets/how-to/destroy/), for step 10.
- [Docker runbook](../runbook-docker.md) in this repository, for the install, the wizard, backups, updates and troubleshooting.
