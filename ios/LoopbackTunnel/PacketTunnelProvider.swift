import NetworkExtension

final class PacketTunnelProvider: NEPacketTunnelProvider {
    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "10.7.0.1")
        let ipv4 = NEIPv4Settings(addresses: ["10.7.0.2"], subnetMasks: ["255.255.255.255"])
        ipv4.includedRoutes = [NEIPv4Route(destinationAddress: "10.7.0.1", subnetMask: "255.255.255.255")]
        settings.ipv4Settings = ipv4
        settings.mtu = 1500
        setTunnelNetworkSettings(settings) { error in
            completionHandler(error)
            if error == nil { self.reflect() }
        }
    }

    private func reflect() {
        packetFlow.readPackets { packets, protocols in
            self.packetFlow.writePackets(packets.map(swapped), withProtocols: protocols)
            self.reflect()
        }
    }
}

private func swapped(_ packet: Data) -> Data {
    guard packet.count >= 20, packet[packet.startIndex] >> 4 == 4 else { return packet }
    var bytes = [UInt8](packet)
    for offset in 0..<4 { bytes.swapAt(12 + offset, 16 + offset) }
    return Data(bytes)
}
