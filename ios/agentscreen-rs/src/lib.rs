use std::ffi::{CStr, CString, c_char};
use std::net::SocketAddr;
use std::sync::Mutex;

use idevice::IdeviceError;
use idevice::RsdService;
use idevice::remote_pairing::{RemotePairingClient, RpPairingFile, RpPairingSocket, connect_tls_psk_tunnel_native};
use idevice::rsd::RsdHandshake;
use idevice::services::dvt::xctest::listener::XCUITestListener;
use idevice::services::dvt::xctest::{TestConfig, XCUITestService};
use idevice::services::installation_proxy::InstallationProxyClient;
use serde_json::json;

const LOOPBACK: &str = "10.7.0.1:49152";
const NAME: &str = "pi";

enum Link {
    Idle,
    Starting,
    Running,
    Ended(String),
}

static LINK: Mutex<Link> = Mutex::new(Link::Idle);
static APPS: Mutex<String> = Mutex::new(String::new());

fn set(link: Link) {
    *LINK.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = link;
}

fn owned(text: String) -> *mut c_char {
    CString::new(text).unwrap_or_default().into_raw()
}

#[unsafe(no_mangle)]
pub extern "C" fn agentscreen_start(pairing: *const c_char, runner: *const c_char) {
    let pairing = unsafe { CStr::from_ptr(pairing) }.to_string_lossy().into_owned();
    let runner = unsafe { CStr::from_ptr(runner) }.to_string_lossy().into_owned();
    {
        let mut link = LINK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(*link, Link::Starting | Link::Running) {
            return;
        }
        *link = Link::Starting;
    }
    std::thread::spawn(move || {
        let ended = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(IdeviceError::Socket)
            .and_then(|runtime| runtime.block_on(run(&pairing, &runner)));
        set(Link::Ended(match ended {
            Ok(()) => "the runner stopped".into(),
            Err(error) => error.to_string(),
        }));
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn agentscreen_state() -> *mut c_char {
    let state = match &*LINK.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) {
        Link::Idle => json!({ "state": "idle" }),
        Link::Starting => json!({ "state": "starting" }),
        Link::Running => json!({ "state": "running" }),
        Link::Ended(why) => json!({ "state": "ended", "why": why }),
    };
    owned(state.to_string())
}

#[unsafe(no_mangle)]
pub extern "C" fn agentscreen_apps() -> *mut c_char {
    owned(APPS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone())
}

#[unsafe(no_mangle)]
pub extern "C" fn agentscreen_free(text: *mut c_char) {
    if !text.is_null() {
        drop(unsafe { CString::from_raw(text) });
    }
}

async fn run(pairing: &str, runner: &str) -> Result<(), IdeviceError> {
    let address: SocketAddr = LOOPBACK.parse().map_err(|_| IdeviceError::FfiInvalidArg)?;
    let mut file = RpPairingFile::read_from_file(pairing).await?;
    let stream = tokio::net::TcpStream::connect(address).await.map_err(IdeviceError::Socket)?;
    let mut pairing = RemotePairingClient::new(RpPairingSocket::new(stream), NAME);
    pairing.connect(&mut file, async || String::new()).await?;
    let mut tunnel_address = address;
    tunnel_address.set_port(pairing.create_tcp_listener().await?);
    let tunnel_stream = tokio::net::TcpStream::connect(tunnel_address).await.map_err(IdeviceError::Socket)?;
    let tunnel = connect_tls_psk_tunnel_native(tunnel_stream, pairing.encryption_key()).await?;
    let client = tunnel.info.client_address.parse().map_err(|_| IdeviceError::FfiInvalidArg)?;
    let server = tunnel.info.server_address.parse().map_err(|_| IdeviceError::FfiInvalidArg)?;
    let mtu = tunnel.info.mtu as usize;
    let rsd_port = tunnel.info.server_rsd_port;
    let mut adapter = idevice::tcp::adapter::Adapter::new(Box::new(tunnel.into_inner()), client, server);
    adapter.set_mss(mtu.min(8192) - 60);
    let mut adapter = adapter.to_async_handle();
    let mut handshake = RsdHandshake::new(adapter.connect(rsd_port).await.map_err(IdeviceError::Socket)?).await?;
    let major = major_version(&handshake);
    let mut installed = InstallationProxyClient::connect_rsd(&mut adapter, &mut handshake).await?;
    *APPS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = app_names(&mut installed).await?;
    let config = TestConfig::from_installation_proxy(&mut installed, runner, None).await?;
    set(Link::Running);
    XCUITestService::run_over_rsd(adapter, &handshake, major, config, &mut Silent, None).await
}

fn major_version(handshake: &RsdHandshake) -> u8 {
    ["OSVersion", "ProductVersion"]
        .iter()
        .find_map(|key| handshake.properties.get(*key).and_then(|value| value.as_string()))
        .and_then(|version| version.split('.').next()?.parse().ok())
        .unwrap_or(27)
}

async fn app_names(installed: &mut InstallationProxyClient) -> Result<String, IdeviceError> {
    let apps = installed.get_apps(Some("Any"), None).await?;
    let names: serde_json::Map<String, serde_json::Value> = apps
        .iter()
        .filter_map(|(bundle, info)| {
            let info = info.as_dictionary()?;
            let name = ["CFBundleDisplayName", "CFBundleName"].iter().find_map(|key| info.get(*key)?.as_string())?;
            Some((bundle.clone(), json!(name)))
        })
        .collect();
    Ok(serde_json::Value::Object(names).to_string())
}

struct Silent;

impl XCUITestListener for Silent {}
