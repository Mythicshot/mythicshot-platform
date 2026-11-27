# Host on AWS Lightsail

> [!WARNING]
> Draft: Not yet verified on a real account. This guide is written from Lightsail's documentation and from the code in this repository, and has not yet been run on a real Lightsail account. Where a label in the control panel could not be confirmed, the guide says what to achieve and that the label may differ.

> [!NOTE]
> There is no published image yet. You need a copy of this repository, and a computer with Docker to build the image from it, as [step 4 of the Docker runbook](../runbook-docker.md#4-build-the-app-image-and-copy-it-to-the-server) describes.

This guide takes you from no hosting to a running platform on one Amazon Lightsail instance (Lightsail is the part of AWS that rents servers at a flat monthly price). The install itself is the [Docker runbook](../runbook-docker.md); this guide adds the Lightsail steps around it.

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
2. An AWS account with a payment method. You create it yourself; this guide does not cover sign-up.
3. A copy of this repository.
4. A computer with Docker, to build the app image. [Get Docker](https://docs.docker.com/get-started/get-docker/) has the installers for Windows, macOS and Linux.
5. A terminal with `ssh` and `scp`. Windows 10 and 11, macOS and Linux all have them.

Prices checked 2026-11-17, in US dollars before tax.

| What | Price | Note |
|---|---|---|
| Linux instance with a public IPv4 address, 1 GB plan | [$7 a month](https://aws.amazon.com/lightsail/pricing/) | 2 vCPUs, 1 GB memory, 40 GB SSD, 2 TB transfer |
| Static IP address | [Free while attached to an instance](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html) | $0.005 an hour once it is unattached for more than an hour |
| Snapshots, optional | [$0.05 per GB a month](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html) | Manual and automatic snapshots cost the same |

The [$5 plan](https://aws.amazon.com/lightsail/pricing/) has 0.5 GB of memory, which is too little for this guide. The cheaper IPv6-only plans have no public IPv4 address and do not fit either.

> [!WARNING]
> A stopped instance is still billed. [AWS's billing FAQ](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html) says instances accrue charges until they are deleted, even in the stopped state.

## 2. Create the server

The steps follow [AWS's "Create an instance" page](https://docs.aws.amazon.com/lightsail/latest/userguide/getting-started-with-amazon-lightsail.html).

1. Sign in to the Lightsail console. On the home page, choose **Create instance**.
2. Select a location: the AWS Region closest to you and your visitors.
3. Choose the **Linux** platform.
4. Choose an operating system only (**OS Only**), not an app, and pick Debian 13. [AWS's blueprint list](https://docs.aws.amazon.com/lightsail/latest/userguide/compare-options-choose-lightsail-instance-image.html) names Debian 13, 12 and 11, and says new Debian 11 instances can no longer be created.
5. Choose **dual-stack** networking (IPv4 and IPv6). Do not choose IPv6-only: the install needs a public IPv4 address.
6. Choose the instance plan at [$7 a month](https://aws.amazon.com/lightsail/pricing/) with 1 GB of memory.
7. Enter a name for the instance, such as `tours`.
8. Choose **Create instance**.

Then give it an address that does not change. [AWS's static IP page](https://docs.aws.amazon.com/lightsail/latest/userguide/lightsail-create-static-ip.html) says the default public address changes every time the instance is stopped and started.

9. In the left navigation pane, choose **Networking**.
10. Choose **Create static IP**.
11. Select the same AWS Region as the instance, choose your instance as the resource to attach it to, and enter a name.
12. Choose **Create**.

**How to tell it worked:** the instance's **Networking** tab shows the public IP address with a pushpin next to it. Write the address down: it is the `203.0.113.10` of this guide.

## 3. Open ports 80 and 443

The platform needs these ports open from the internet.

| Port | Protocol | Why |
|---|---|---|
| 80 | TCP | The certificate authority checks the server here |
| 443 | TCP | HTTPS |
| 443 | UDP | HTTP/3, optional |

Every Lightsail instance sits behind Lightsail's firewall. [AWS's firewall page](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-firewall-and-port-mappings-in-amazon-lightsail.html) says a new Debian instance opens only two ports:

| Open by default | Port |
|---|---|
| SSH | TCP 22 |
| HTTP | TCP 80 |

So port 443 is closed until you open it. The same page says each instance has two firewalls, one for IPv4 and one for IPv6, and that you must add rules to each separately.

1. In the left navigation pane, choose **Instances**, then the name of your instance. The labels are from [AWS's "add firewall rules" page](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-editing-firewall-rules.html).
2. Choose the **Networking** tab.
3. In the **IPv4 Firewall** section, choose **Add rule**.
4. In **Application**, choose **HTTPS**. This sets TCP and port 443.
5. Choose **Create**.
6. If you plan to add an AAAA record in [step 4](#4-point-the-domain-at-the-server), scroll down to the **IPv6 Firewall** section and add the same HTTPS rule there.
7. Optional, for HTTP/3: add one more rule with **Custom**, protocol UDP and port 443.

**How to tell it worked:** the IPv4 firewall lists SSH, HTTP and HTTPS.

> [!WARNING]
> A firewall on the server itself does not protect these ports: Docker's page warns that ports a container publishes bypass such rules. See [step 3 of the runbook](../runbook-docker.md#3-open-ports-80-and-443).

## 4. Point the domain at the server

Do this at the company that runs your domain's DNS. The words differ a little between companies, but every one has a page to add DNS records.

1. Find that page. It is often called DNS, DNS records, Zone editor or Advanced DNS.
2. Add a record with these values. If the form wants the full name, type `tours.example.com` with your own domain.

| Type | Name (also called Host) | Value (also called Points to) | TTL |
|---|---|---|---|
| A | `tours` | `203.0.113.10`, the server's IPv4 address | leave the default |

3. A dual-stack instance also has an IPv6 address, shown on its **Networking** tab. You may add an AAAA record with the same name and that address, such as `2001:db8::10`, but only if you added the HTTPS rule to the IPv6 firewall in step 3. If you are not sure, add none: the platform works over IPv4 alone.
4. Save the record.

> [!WARNING]
> Add an AAAA record only if ports 80 and 443 are open over IPv6 too. A wrong AAAA record can stop the HTTPS certificate from being issued.

**How to tell it worked:** after [step 5](#5-connect-by-ssh), this command on the server prints the address you entered. A new record can take a few minutes to show up.

```sh
getent ahosts tours.example.com
```

## 5. Connect by SSH

You need your own terminal, not only the browser-based SSH client, because [step 6](#6-install-the-platform) copies a file from your computer with `scp`. The steps follow [AWS's "connect with SSH" page](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-ssh-using-terminal.html).

1. On the Lightsail home page, choose your user name in the top navigation menu, then **Account**.
2. Choose the **SSH keys** tab.
3. Choose the download icon next to the default key of the AWS Region your instance is in. Keep the file somewhere safe. This guide calls it `lightsail-key.pem`.
4. On macOS or Linux, make the key file readable by you only.

```sh
chmod 400 lightsail-key.pem
```

5. Connect. The same AWS page says the user name on Debian instances is `admin`.

```sh
ssh -i lightsail-key.pem admin@203.0.113.10
```

6. The first time, the terminal asks whether you are sure you want to continue connecting. Type `yes`.

> [!WARNING]
> The key file lets anyone log in to the server as an administrator. Never share it or put it in a repository.

**How to tell it worked:** this prints a line naming Debian GNU/Linux 13 (trixie).

```sh
grep PRETTY_NAME /etc/os-release
```

## 6. Install the platform

These are steps 4 and 5 of the [Docker runbook](../runbook-docker.md#4-build-the-app-image-and-copy-it-to-the-server), with the Lightsail login filled in. The runbook explains each step, every question the script asks and every message it can print.

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
scp -i lightsail-key.pem demo-platform.tar deploy/install.sh admin@203.0.113.10:
```

5. On the server, read the script before you run it as root.

```sh
less install.sh
```

6. Run it once. It asks for the domain name (`tours.example.com`), an email address for the certificate, and the data folder (press Enter). It installs Docker and then stops, saying the app image is not on this server. That is expected.

```sh
sudo bash install.sh
```

7. Load the image you copied.

```sh
sudo docker load -i demo-platform.tar
```

8. Run the script again. This time it starts the platform.

```sh
sudo bash install.sh
```

At the end it prints the address and the setup code. This is the only time the code is printed.

> [!WARNING]
> Whoever enters the setup code first becomes the owner of the platform. Keep it private until you finish [step 7](#7-open-the-setup-wizard).

**How to tell it worked:** this shows both containers running and the app `healthy`.

```sh
sudo bash install.sh status
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
sudo bash install.sh backup
```

2. Copy the archive to your own computer, as [step 9 of the runbook](../runbook-docker.md#9-back-up-and-restore) shows. The same section has the restore steps.

> [!WARNING]
> A backup that stays on the server is lost with the server. Copy every archive somewhere else, and keep it as private as a password: it holds the owner's email, the token hashes and every draft image.

**Lightsail's automatic snapshots** are an extra, not a replacement. [AWS's snapshot page](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-configuring-automatic-snapshots.html) says they are taken daily and the latest seven are kept, at [$0.05 per GB a month](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html). To turn them on: choose your instance, open the **Snapshots** tab, switch on the toggle under **Automatic snapshots** and confirm with **Yes, enable**. A snapshot copies the whole disk while the database is in use, so restore from the platform's archive when you can.

## 9. Updates

**The platform.** There is no published image, so an update is a new image built from a newer copy of the repository.

1. On your computer, build and save the image again and copy it to the server, as in [step 6](#6-install-the-platform), items 2 to 4.
2. On the server, load it.

```sh
sudo docker load -i demo-platform.tar
```

3. Run the update. It writes a backup first, then restarts on the new image.

```sh
sudo bash install.sh update
```

**Debian.** Keeping the server patched is yours to do. Run these now and then, and restart the server from Lightsail's control panel when a new kernel was installed.

```sh
sudo apt-get update
```

```sh
sudo apt-get upgrade
```

The [runbook's update step](../runbook-docker.md#8-update) has the details.

## 10. Delete everything to stop paying

1. Make a backup and copy it off the server first, as in [step 8](#8-backups). After the next steps the data is gone.
2. On the Lightsail home page, choose your instance, then the **Delete** button, then **Delete instance**. These labels are from [AWS's "delete instances" page](https://docs.aws.amazon.com/lightsail/latest/userguide/delete-an-amazon-lightsail-instance.html).
3. Select the checkbox, type the confirmation word the page asks for, and choose **Delete instance**.
4. Delete the static IP as well: [AWS's page](https://docs.aws.amazon.com/lightsail/latest/userguide/how-to-delete-static-ip.html) says it stays in your account after the instance is gone, and an unattached static IP is billed. In the left navigation pane, choose **Networking**, then the ⋮ icon next to the static IP, then **Delete**.
5. Open the snapshots list and delete any manual snapshots you made. They are billed until deleted.

> [!WARNING]
> A deleted instance cannot be recovered, and AWS's page says its automatic snapshots are deleted with it. Copy your own backup off the server first.

Last, remove the A record (and the AAAA record) for `tours.example.com` at your DNS company, so the name no longer points at an address that is not yours.

## Pages this guide relies on

Opened on 2026-11-17.

- [Lightsail pricing](https://aws.amazon.com/lightsail/pricing/), for the plan, its size and its price.
- [Billing FAQ](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html), for static IP and snapshot prices and billing while stopped.
- [Blueprint offerings](https://docs.aws.amazon.com/lightsail/latest/userguide/compare-options-choose-lightsail-instance-image.html), for the Debian 13 image.
- [Create an instance](https://docs.aws.amazon.com/lightsail/latest/userguide/getting-started-with-amazon-lightsail.html) and [create a static IP](https://docs.aws.amazon.com/lightsail/latest/userguide/lightsail-create-static-ip.html), for step 2.
- [Firewalls](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-firewall-and-port-mappings-in-amazon-lightsail.html) and [add firewall rules](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-editing-firewall-rules.html), for step 3.
- [Connect with the SSH command](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-ssh-using-terminal.html), for step 5.
- [Automatic snapshots](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-configuring-automatic-snapshots.html), for step 8.
- [Delete instances](https://docs.aws.amazon.com/lightsail/latest/userguide/delete-an-amazon-lightsail-instance.html) and [delete a static IP](https://docs.aws.amazon.com/lightsail/latest/userguide/how-to-delete-static-ip.html), for step 10.
- [Docker runbook](../runbook-docker.md) in this repository, for the install, the wizard, backups, updates and troubleshooting.
