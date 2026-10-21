package dev.geminixiang.pimobile;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanner;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.UUID;

/**
 * ML Kit through Google Play services, whose models it downloads and updates, so the app carries none: the document
 * scanner (the system's camera screen that finds the page edges and flattens them; the user takes the pages and
 * presses done), and text recognition for Chinese and Latin script, on the phone.
 */
@CapacitorPlugin(name = "Scanner")
public class ScannerPlugin extends Plugin {

    private ActivityResultLauncher<IntentSenderRequest> launcher;
    private PluginCall pending;
    private TextRecognizer recognizer;

    @Override
    public void load() {
        // Registered while the activity is created, as the Activity Result API requires.
        launcher = getActivity().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), result -> {
            PluginCall call = pending;
            pending = null;
            if (call == null) return;
            if (result.getResultCode() != Activity.RESULT_OK) {
                call.reject("cancelled", "cancelled");
                return;
            }
            GmsDocumentScanningResult scan = GmsDocumentScanningResult.fromActivityResultIntent(result.getData());
            if (scan == null || scan.getPdf() == null) {
                call.reject("the scanner returned nothing");
                return;
            }
            try {
                File pdf = copy(scan.getPdf().getUri(), ".pdf");
                JSObject answer = new JSObject();
                answer.put("pdf", pdf.getAbsolutePath());
                answer.put("pages", scan.getPdf().getPageCount());
                JSArray pages = new JSArray();
                if (scan.getPages() != null) for (GmsDocumentScanningResult.Page page : scan.getPages()) pages.put(copy(page.getImageUri(), ".jpg").getAbsolutePath());
                answer.put("images", pages);
                call.resolve(answer);
            } catch (IOException error) {
                call.reject("could not keep the scan", error);
            }
        });
    }

    /** The scan's files into the inbox, which the web side reads through Capacitor's file server. */
    private File copy(Uri uri, String suffix) throws IOException {
        File target = new File(TriggerStore.inbox(getContext()), UUID.randomUUID() + suffix);
        try (InputStream in = getContext().getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(target)) {
            if (in == null) throw new IOException("no data at " + uri);
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
        }
        return target;
    }

    /** Open the document scanner; resolves {pdf, pages, images} (paths), or rejects "cancelled". Only with pi in front. */
    @PluginMethod
    public void scan(PluginCall call) {
        if (!TriggersPlugin.inFront(getActivity())) {
            call.reject("pi is in the background; the scanner needs the user. Ask them to open pi.");
            return;
        }
        GmsDocumentScannerOptions options = new GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(true)
            .setPageLimit(call.getInt("pages", 20))
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_PDF, GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .build();
        GmsDocumentScanner scanner = GmsDocumentScanning.getClient(options);
        scanner
            .getStartScanIntent(getActivity())
            .addOnSuccessListener(sender -> {
                pending = call;
                launcher.launch(new IntentSenderRequest.Builder(sender).build());
            })
            .addOnFailureListener(error -> call.reject("the scanner is not available: " + error.getMessage()));
    }

    /** Text in an image (base64 JPEG or PNG), Chinese and Latin script, in reading order as lines. */
    @PluginMethod
    public void ocr(PluginCall call) {
        byte[] bytes = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
        Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        if (bitmap == null) {
            call.reject("not an image");
            return;
        }
        if (recognizer == null) recognizer = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
        recognizer
            .process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener(text -> {
                JSObject result = new JSObject();
                result.put("text", text.getText());
                call.resolve(result);
            })
            .addOnFailureListener(error -> call.reject("could not read the image: " + error.getMessage()));
    }
}
