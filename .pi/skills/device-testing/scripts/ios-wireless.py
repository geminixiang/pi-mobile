import asyncio
import sys

import pymobiledevice3.remote.tunnel_service as tunnels
import pymobiledevice3.remote.userspace_tunnel as userspace
from pymobiledevice3.exceptions import RemotePairingCompletedError
from pymobiledevice3.lockdown import create_using_usbmux

PAIRING_PORT = 49152
USAGE = "ios-wireless.py pair <udid> | ios-wireless.py <udid> <host> <pymobiledevice3 args...>"


async def pair(udid):
    lockdown = await create_using_usbmux(serial=udid, autopair=False)
    service = await tunnels.RemotePairingLockdownService.create(lockdown)
    try:
        await service.connect(autopair=True)
    except RemotePairingCompletedError:
        pass
    await service.close()
    await lockdown.close()
    print("paired", udid)


def run(udid, host, args):
    async def over_network(serial, autopair, remotepairing_fallback=True):
        service = await tunnels.create_core_device_tunnel_service_using_remotepairing(
            udid, host, PAIRING_PORT, autopair=False
        )
        return service, None

    userspace._create_no_root_tunnel_provider = over_network
    sys.argv = ["pymobiledevice3", *args, "--userspace", "--udid", udid]
    from pymobiledevice3.__main__ import main

    return main()


def start(argv):
    if len(argv) == 2 and argv[0] == "pair":
        return asyncio.run(pair(argv[1]))
    if len(argv) >= 3:
        return run(argv[0], argv[1], argv[2:])
    sys.exit(USAGE)


sys.exit(start(sys.argv[1:]))
