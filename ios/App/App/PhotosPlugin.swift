import Capacitor
import Photos
import UIKit

@objc(PhotosPlugin)
public class PhotosPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PhotosPlugin"
    public let jsName = "Photos"
    public let pluginMethods: [CAPPluginMethod] = ["search", "view"].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    private var allowed: Bool {
        [.authorized, .limited].contains(PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }

    private func withAccess(_ call: CAPPluginCall, _ then: @escaping () -> Void) {
        if allowed {
            DispatchQueue.global(qos: .userInitiated).async(execute: then)
            return
        }
        guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .notDetermined else {
            call.reject("photos permission denied: the user can allow it in Settings › Pi › Photos", "permission")
            return
        }
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState != .background else {
                call.reject("pi has no photos permission yet, and cannot ask for it while it is in the background. Ask the user to open pi and allow it.")
                return
            }
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
                if [.authorized, .limited].contains(status) { DispatchQueue.global(qos: .userInitiated).async(execute: then) } else { call.reject("photos permission denied", "permission") }
            }
        }
    }

    private func millis(_ date: Date?) -> Int64 {
        Int64(((date ?? Date(timeIntervalSince1970: 0)).timeIntervalSince1970 * 1000).rounded())
    }

    @objc func search(_ call: CAPPluginCall) {
        let from = (call.options["from"] as? NSNumber)?.doubleValue ?? 0
        let to = (call.options["to"] as? NSNumber)?.doubleValue ?? Date.distantFuture.timeIntervalSince1970 * 1000
        let limit = call.getInt("limit") ?? 200
        let album = call.getString("album")?.lowercased()
        withAccess(call) {
            let options = PHFetchOptions()
            options.predicate = NSPredicate(format: "creationDate >= %@ AND creationDate <= %@", Date(timeIntervalSince1970: from / 1000) as NSDate, Date(timeIntervalSince1970: to / 1000) as NSDate)
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            var items: [[String: Any]] = []
            let add = { (asset: PHAsset, albumName: String) in
                var item: [String: Any] = [
                    "id": asset.localIdentifier,
                    "name": asset.localIdentifier,
                    "time": self.millis(asset.creationDate),
                    "album": albumName,
                    "width": asset.pixelWidth,
                    "height": asset.pixelHeight,
                ]
                if let place = asset.location?.coordinate {
                    item["latitude"] = place.latitude
                    item["longitude"] = place.longitude
                }
                items.append(item)
            }
            if let album {
                var collections: [PHAssetCollection] = []
                for type in [PHAssetCollectionType.album, .smartAlbum] {
                    PHAssetCollection.fetchAssetCollections(with: type, subtype: .any, options: nil).enumerateObjects { collection, _, _ in
                        if (collection.localizedTitle ?? "").lowercased().contains(album) { collections.append(collection) }
                    }
                }
                var seen = Set<String>()
                var found: [(PHAsset, String)] = []
                for collection in collections {
                    PHAsset.fetchAssets(in: collection, options: options).enumerateObjects { asset, _, _ in
                        if asset.mediaType == .image, seen.insert(asset.localIdentifier).inserted { found.append((asset, collection.localizedTitle ?? album)) }
                    }
                }
                for (asset, name) in found.sorted(by: { ($0.0.creationDate ?? .distantPast) > ($1.0.creationDate ?? .distantPast) }).prefix(limit) { add(asset, name) }
            } else {
                options.fetchLimit = limit
                PHAsset.fetchAssets(with: .image, options: options).enumerateObjects { asset, _, _ in
                    add(asset, asset.mediaSubtypes.contains(.photoScreenshot) ? "Screenshots" : "Camera")
                }
            }
            call.resolve(["items": items])
        }
    }

    @objc func view(_ call: CAPPluginCall) {
        guard allowed else {
            call.reject("no photos permission")
            return
        }
        let id = call.getString("id") ?? ""
        let edge = CGFloat(call.getInt("edge") ?? 1280)
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
            call.reject("no photo with id \(id)", "not_found")
            return
        }
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: edge, height: edge), contentMode: .aspectFit, options: options) { image, info in
            guard let image, let data = image.jpegData(compressionQuality: 0.85) else {
                let error = info?[PHImageErrorKey] as? Error
                call.reject("could not read that photo\(error.map { ": \($0.localizedDescription)" } ?? "")")
                return
            }
            call.resolve(["data": data.base64EncodedString(), "width": Int(image.size.width * image.scale), "height": Int(image.size.height * image.scale)])
        }
    }
}
