# Host on an Azure virtual machine

> [!WARNING]
> Draft: Not yet verified on a real account. This guide is written from Azure's documentation and from the code in this repository, and has not yet been run on a real Azure account. Where a label in the control panel could not be confirmed, the guide says what to achieve and that the label may differ.

> [!NOTE]
> There is no published image yet. You need a copy of this repository, and a computer with Docker to build the image from it, as [step 4 of the Docker runbook](../runbook-docker.md#4-build-the-app-image-and-copy-it-to-the-server) describes.

This guide takes you from no hosting to a running platform on one Azure virtual machine. The install itself is the [Docker runbook](../runbook-docker.md); this guide adds the Azure steps around it.

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
2. An Azure account with a subscription and a payment method. You create it yourself; this guide does not cover sign-up.
3. A copy of this repository.
4. A computer with Docker, to build the app image. [Get Docker](https://docs.docker.com/get-started/get-docker/) has the installers for Windows, macOS and Linux.
5. A terminal with `ssh` and `scp`. Windows 10 and 11, macOS and Linux all have them.

Prices checked 2026-11-17, in US dollars before tax, for the East US region, read from [Microsoft's public price list](https://prices.azure.com/api/retail/prices?%24filter=serviceName%20eq%20%27Virtual%20Machines%27%20and%20armRegionName%20eq%20%27eastus%27%20and%20priceType%20eq%20%27Consumption%27%20and%20%28skuName%20eq%20%27B2ats%20v2%27%20or%20skuName%20eq%20%27B2pts%20v2%27%29). Other regions differ. Monthly figures are our arithmetic, at 730 hours a month.

> [!WARNING]
> On Azure the server, its disk and its public IP address are three separate lines on the bill. The server's hourly price alone is about half of what you pay.

| What | Price | A month |
|---|---|---|
| Virtual machine, size B2ats v2 (x86, 2 vCPUs, 1 GiB) | [$0.0094 an hour](https://prices.azure.com/api/retail/prices?%24filter=serviceName%20eq%20%27Virtual%20Machines%27%20and%20armRegionName%20eq%20%27eastus%27%20and%20priceType%20eq%20%27Consumption%27%20and%20%28skuName%20eq%20%27B2ats%20v2%27%20or%20skuName%20eq%20%27B2pts%20v2%27%29) | About $6.86 |
| OS disk, Standard SSD, 32 GiB (E4) | [$2.40 a month](https://prices.azure.com/api/retail/prices?%24filter=serviceName%20eq%20%27Storage%27%20and%20armRegionName%20eq%20%27eastus%27%20and%20priceType%20eq%20%27Consumption%27%20and%20meterName%20eq%20%27E4%20LRS%20Disk%27) | $2.40 |
| Public IPv4 address, Standard, static | [$0.005 an hour](https://prices.azure.com/api/retail/prices?%24filter=armRegionName%20eq%20%27eastus%27%20and%20priceType%20eq%20%27Consumption%27%20and%20serviceName%20eq%20%27Virtual%20Network%27%20and%20productName%20eq%20%27IP%20Addresses%27) | About $3.65 |
| **Total** | | **About $12.91** |

The same server on Arm, size B2pts v2, is [$0.0084 an hour](https://prices.azure.com/api/retail/prices?%24filter=serviceName%20eq%20%27Virtual%20Machines%27%20and%20armRegionName%20eq%20%27eastus%27%20and%20priceType%20eq%20%27Consumption%27%20and%20%28skuName%20eq%20%27B2ats%20v2%27%20or%20skuName%20eq%20%27B2pts%20v2%27%29), about $6.13 a month, which brings the total to about $12.18. Outbound traffic is billed separately too; its price was not re-checked for this guide.

**Which size to choose.** B2ats v2 and B2pts v2 are the smallest sizes of Azure's B-series that fit: both have 2 vCPUs and 1 GiB of memory. [B2ats v2 runs on AMD x86-64 processors](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/basv2-series) and [B2pts v2 on Arm64 processors](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/bpsv2-series). The platform's Dockerfile builds for both: its base image is a multi-platform Node image. What decides it is your own computer and the Debian image:

- Choose **B2ats v2** if your computer has an Intel or AMD processor. The image you build is then the right kind without extra steps. This guide assumes this size.
- Choose **B2pts v2** only if your computer is Arm too (an Apple-silicon Mac, for example) and the portal offers you an Arm64 Debian 12 image. [Microsoft's list of endorsed distributions](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/endorsed-distros) names Debian 12 but does not say whether it comes for Arm64, so this could not be confirmed.

A virtual machine and its image must match: an Arm64 size needs an Arm64 image, and an x86 size an x64 image.

> [!WARNING]
> Stopping the virtual machine does not stop the bill. [Microsoft's billing-states page](https://learn.microsoft.com/en-us/azure/virtual-machines/states-billing) says a machine that is only "Stopped" is still billed, and even a "Deallocated" one keeps paying for its disk and networking.

## 2. Create the server

The labels below are the ones [Microsoft's "create a Linux VM in the portal" quickstart](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/quick-create-portal) uses. The quickstart uses Ubuntu; the differences for this guide are the image, the size and the ports.

1. Sign in to the Azure portal. Enter *virtual machines* in the search box and, under **Services**, select **Virtual machines**.
2. Select **Create**, then **Virtual machine**. The **Create a virtual machine** page opens on the **Basics** tab.
3. Under **Project details**, choose **Create new** for the resource group and name it, for example `tours-rg`. Everything this guide creates goes into this one group, which makes [step 10](#10-delete-everything-to-stop-paying) simple.
4. Under **Instance details**, enter a **Virtual machine name**, such as `tours`, and pick the region closest to you and your visitors.
5. Under **Availability options**, select *No infrastructure redundancy required*. Under **Security type**, select *Standard*.
6. For **Image**, choose Debian 12 "Bookworm" for x64. You may have to open the full image list and search for Debian. [Microsoft's list of endorsed distributions](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/endorsed-distros) names Debian 11 and Debian 12; Debian 13 is not on it, so Debian 12 is the version this guide could verify. The install script accepts Debian 12 and prints a notice.
7. For **Size**, open the full list of sizes and choose **B2ats v2** (shown as Standard_B2ats_v2). If the list does not offer it, your subscription or region may not have it: pick another region, or the next size up.
8. Under **Administrator account**, select **SSH public key** for **Authentication type**. Leave **Username** as *azureuser* or choose your own.
9. For **SSH public key source**, leave **Generate new key pair** and enter a **Key pair name**, such as `tours-key`.
10. Under **Inbound port rules**, set **Public inbound ports** to **Allow selected ports** and select **SSH (22)**, **HTTP (80)** and, if the list offers it, **HTTPS (443)**. The quickstart shows only the first two; if 443 is missing, you add it in [step 3](#3-open-ports-80-and-443).
11. Open the disks page of the form and choose a Standard SSD for the OS disk, not Premium SSD, to match the price above. Open the networking page and check that a new public IP address is selected. If the form shows whether the address is static or dynamic, choose static. These labels could not be confirmed and may differ.
12. Select **Review + create**, check the summary, then select **Create**.
13. When the **Generate new key pair** window opens, select **Download private key and create resource**. The key file is saved as a `.pem` file, here `tours-key.pem`.
14. When the deployment is finished, select **Go to resource**.

> [!WARNING]
> The key file lets anyone log in to the server as an administrator. Never share it or put it in a repository.

**How to tell it worked:** the virtual machine's page shows its **Public IP address**. Write it down: it is the `203.0.113.10` of this guide.

## 3. Open ports 80 and 443

The platform needs these ports open from the internet.

| Port | Protocol | Why |
|---|---|---|
| 80 | TCP | The certificate authority checks the server here |
| 443 | TCP | HTTPS |
| 443 | UDP | HTTP/3, optional |

On Azure the control-panel firewall is a network security group. [Microsoft's overview](https://learn.microsoft.com/en-us/azure/virtual-network/network-security-groups-overview) lists its default rules: the last inbound rule, DenyAllInbound, refuses everything from the internet that no earlier rule allows. So only the ports you ticked in step 2 are open.

If you ticked SSH, HTTP and HTTPS when creating the machine, check the list and move on. If HTTPS was not offered, add it. The field names below are from [Microsoft's network security group tutorial](https://learn.microsoft.com/en-us/azure/virtual-network/tutorial-filter-network-traffic); how you reach the list from the virtual machine's page may differ.

1. On the virtual machine's page, open its networking settings and find the inbound port rules of its network security group.
2. Start a new inbound rule (the tutorial's button is **+ Add**).
3. Leave **Source** as **Any** and **Source port ranges** as `*`.
4. Enter `443` in **Destination port ranges** and select **TCP** as **Protocol**.
5. Leave **Action** as **Allow**, keep the suggested **Priority**, and enter a **Name**, such as `allow-https`.
6. Select **Add**.
7. Optional, for HTTP/3: add one more rule for port 443 with **UDP**.

**How to tell it worked:** the inbound rules list ports 22, 80 and 443 as allowed, above the deny rule.

> [!WARNING]
> A firewall on the server itself does not protect these ports: Docker's page warns that ports a container publishes bypass such rules. See [step 3 of the runbook](../runbook-docker.md#3-open-ports-80-and-443).

## 4. Point the domain at the server

Do this at the company that runs your domain's DNS. The words differ a little between companies, but every one has a page to add DNS records.

1. Find that page. It is often called DNS, DNS records, Zone editor or Advanced DNS.
2. Add a record with these values. If the form wants the full name, type `tours.example.com` with your own domain.

| Type | Name (also called Host) | Value (also called Points to) | TTL |
|---|---|---|---|
| A | `tours` | `203.0.113.10`, the server's IPv4 address | leave the default |

3. Add no AAAA record. The virtual machine this guide creates has an IPv4 address only.
4. Save the record.

> [!WARNING]
> Add an AAAA record only if ports 80 and 443 are open over IPv6 too. A wrong AAAA record can stop the HTTPS certificate from being issued.

**How to tell it worked:** after [step 5](#5-connect-by-ssh), this command on the server prints the address you entered. A new record can take a few minutes to show up.

```sh
getent ahosts tours.example.com
```

## 5. Connect by SSH

The command is the one [Microsoft's quickstart](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/quick-create-portal) gives, with this guide's names.

1. On macOS or Linux, make the key file readable by you only. On Windows, skip this.

```sh
chmod 400 tours-key.pem
```

2. Connect, with the user name you chose in step 2.

```sh
ssh -i tours-key.pem azureuser@203.0.113.10
```

3. The first time, the terminal asks whether you are sure you want to continue connecting. Type `yes`.

**How to tell it worked:** this prints a line naming Debian GNU/Linux 12 (bookworm).

```sh
grep PRETTY_NAME /etc/os-release
```

## 6. Install the platform

These are steps 4 and 5 of the [Docker runbook](../runbook-docker.md#4-build-the-app-image-and-copy-it-to-the-server), with the Azure login filled in. The runbook explains each step, every question the script asks and every message it can print.

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
scp -i tours-key.pem demo-platform.tar deploy/install.sh azureuser@203.0.113.10:
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

**Azure's own backups** are an extra, not a replacement. Azure can take [a snapshot of the machine's disk](https://learn.microsoft.com/en-us/azure/virtual-machines/snapshot-copy-managed-disk), and has a separate Azure Backup service. Neither was priced for this guide, so check the price in the portal before you turn one on. A snapshot copies the whole disk while the database is in use, so restore from the platform's archive when you can.

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

**Debian.** Keeping the server patched is yours to do. Run these now and then, and restart the server from Azure's control panel when a new kernel was installed.

```sh
sudo apt-get update
```

```sh
sudo apt-get upgrade
```

The [runbook's update step](../runbook-docker.md#8-update) has the details.

## 10. Delete everything to stop paying

1. Make a backup and copy it off the server first, as in [step 8](#8-backups). After the next steps the data is gone.
2. On the virtual machine's **Overview** page, under **Essentials**, select the link to the resource group you created in step 2. These steps are from [Microsoft's quickstart](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/quick-create-portal) and its [page on deleting resource groups](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/delete-resource-group).
3. At the top of the resource group's page, select **Delete resource group**.
4. Type the name of the resource group to confirm, and select **Delete**.
5. Afterwards, search the portal for the resource group's name. Nothing should be left: the virtual machine, its disk, its public IP address and its network security group all lived in that group.

> [!WARNING]
> Microsoft's page says "Resource group deletion is irreversible", and it deletes everything in the group. Make sure the group holds nothing but this server.

Last, remove the A record (and the AAAA record) for `tours.example.com` at your DNS company, so the name no longer points at an address that is not yours.

## Pages this guide relies on

Opened on 2026-11-17.

- [Microsoft's public price list](https://prices.azure.com/api/retail/prices?%24filter=serviceName%20eq%20%27Virtual%20Machines%27%20and%20armRegionName%20eq%20%27eastus%27%20and%20priceType%20eq%20%27Consumption%27%20and%20%28skuName%20eq%20%27B2ats%20v2%27%20or%20skuName%20eq%20%27B2pts%20v2%27%29) for the two sizes, [the disk](https://prices.azure.com/api/retail/prices?%24filter=serviceName%20eq%20%27Storage%27%20and%20armRegionName%20eq%20%27eastus%27%20and%20priceType%20eq%20%27Consumption%27%20and%20meterName%20eq%20%27E4%20LRS%20Disk%27) and [the public IP address](https://prices.azure.com/api/retail/prices?%24filter=armRegionName%20eq%20%27eastus%27%20and%20priceType%20eq%20%27Consumption%27%20and%20serviceName%20eq%20%27Virtual%20Network%27%20and%20productName%20eq%20%27IP%20Addresses%27). These are plain data pages that need no account.
- [Basv2 sizes](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/basv2-series) and [Bpsv2 sizes](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/bpsv2-series), for the two sizes and their processors.
- [Endorsed Linux distributions](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/endorsed-distros), for the Debian versions.
- [Quickstart: create a Linux VM in the portal](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/quick-create-portal), for steps 2, 5 and 10.
- [Network security groups overview](https://learn.microsoft.com/en-us/azure/virtual-network/network-security-groups-overview) and [the network security group tutorial](https://learn.microsoft.com/en-us/azure/virtual-network/tutorial-filter-network-traffic), for step 3.
- [States and billing status](https://learn.microsoft.com/en-us/azure/virtual-machines/states-billing), for the cost warning.
- [Create a snapshot of a disk](https://learn.microsoft.com/en-us/azure/virtual-machines/snapshot-copy-managed-disk), for step 8. Only its existence was checked, not its steps.
- [Delete resource groups](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/delete-resource-group), for step 10.
- [Docker runbook](../runbook-docker.md) in this repository, for the install, the wizard, backups, updates and troubleshooting.
