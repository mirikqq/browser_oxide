//! Run the local Web API probe; optional `--http` also checks GET/POST on loopback.

fn main() {
    std::thread::Builder::new()
        .stack_size(64 * 1024 * 1024)
        .spawn(run)
        .expect("start V8 thread")
        .join()
        .expect("V8 thread failed");
}

#[tokio::main(flavor = "current_thread")]
async fn run() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: compatibility_probe <probe.html> [--http]");
    let html = std::fs::read_to_string(path).expect("read probe HTML");
    if std::env::args().any(|arg| arg == "--http") {
        tokio::time::timeout(std::time::Duration::from_secs(15), check_http())
            .await
            .expect("HTTP probe timed out");
    }
    tokio::task::LocalSet::new()
        .run_until(async {
            let pool = browser_oxide::PagePool::new(1);
            let mut page = pool
                .acquire(Some(browser_oxide::stealth::presets::chrome_148_macos()))
                .await
                .expect("acquire page");
            page.reload_html(&html, "http://127.0.0.1:18763/compatibility_probe.html");
            page.event_loop()
                .run_until_idle(std::time::Duration::from_secs(10))
                .await
                .expect("drive event loop");
            let report = page
                .evaluate("JSON.stringify(globalThis.compatReport)")
                .expect("read probe result");
            let value: serde_json::Value = serde_json::from_str(&report).expect("probe completed");
            println!("{}", serde_json::to_string_pretty(&value).unwrap());
            assert_eq!(value["passed"], value["total"], "Web API probe failed");
        })
        .await;
}

async fn check_http() {
    use std::io::{BufRead, BufReader, Read, Write};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        for (index, method) in ["GET", "GET", "POST", "POST", "POST"].iter().enumerate() {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut stream = BufReader::new(stream);
            let mut request = String::new();
            loop {
                let mut line = String::new();
                assert!(stream.read_line(&mut line).unwrap() > 0);
                request.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            assert!(request.starts_with(&format!("{method} /probe?q=1 HTTP/1.1\r\n")));
            assert!(request.contains(&format!("Host: {address}\r\n")));
            if index > 0 {
                assert!(request.contains("Cookie: probe=1\r\n"));
            }
            if *method == "POST" {
                assert!(request.contains("Content-Length: 4\r\n"));
                let mut body = [0; 4];
                stream.read_exact(&mut body).unwrap();
                assert_eq!(&body, b"ping");
            }
            stream.get_mut().write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nSet-Cookie: probe=1; Path=/\r\nConnection: close\r\n\r\nok").unwrap();
        }
    });
    let client =
        browser_oxide::net::HttpClient::new(&browser_oxide::stealth::presets::chrome_148_macos())
            .unwrap();
    let url = format!("http://{address}/probe?q=1#ignored");
    for index in 0..5 {
        let response = match index {
            0 => client.get_with_headers(&url, &[]).await,
            1 => client.get_with_exact_headers(&url, &[]).await,
            2 => client.post_bytes_with_headers(&url, b"ping", &[]).await,
            3 => {
                client
                    .post_bytes_with_exact_headers(&url, b"ping", &[])
                    .await
            }
            _ => {
                client
                    .post_bytes_with_exact_headers_direct(&url, b"ping", &[])
                    .await
            }
        }
        .expect("HTTP request");
        assert_eq!(response.status, 200);
        assert_eq!(response.body.as_slice(), b"ok");
    }
    assert!(client.get("ftp://127.0.0.1/probe").await.is_err());
    server.join().expect("HTTP server checks");
    eprintln!("HTTP probe: all five GET/POST paths, Host port, body, cookies and unsupported scheme passed");
}
