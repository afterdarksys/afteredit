use super::*;
struct Fixture {
    dir: PathBuf,
    service: Arc<Service>,
}
impl Fixture {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("ae-service-test-{}-{}", std::process::id(), {
                static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
                NEXT.fetch_add(1, Ordering::SeqCst)
            }));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("note.txt"), "original\n").unwrap();
        let service = Service::new(&dir, dir.join("recovery.json")).unwrap();
        Self { dir, service }
    }
    fn call(&self, method: &str, p: Value) -> Value {
        self.service.request(method, p).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
#[test]
fn concurrent_clients_reject_stale_edits_and_external_disk_changes() {
    let f = Fixture::new();
    f.call("buffer.open", json!({"path":"note.txt"}));
    let edited = f.call(
        "buffer.edit",
        json!({"path":"note.txt","version":1,"text":"shared draft\n"}),
    );
    assert_eq!(edited["version"], 2);
    assert!(f
        .service
        .request(
            "buffer.edit",
            json!({"path":"note.txt","version":1,"text":"stale"})
        )
        .unwrap_err()
        .contains("Version conflict"));
    fs::write(f.dir.join("note.txt"), "external").unwrap();
    assert!(f
        .service
        .request("buffer.save", json!({"path":"note.txt","version":2}))
        .is_err());
    assert_eq!(
        fs::read_to_string(f.dir.join("note.txt")).unwrap(),
        "external"
    );
    assert_eq!(
        f.call("buffer.get", json!({"path":"note.txt"}))["text"],
        "shared draft\n"
    );
}
#[test]
fn drafts_undo_history_and_revision_survive_restart() {
    let f = Fixture::new();
    f.call("buffer.open", json!({"path":"note.txt"}));
    f.call(
        "buffer.edit",
        json!({"path":"note.txt","version":1,"text":"unsaved"}),
    );
    let restored = Service::new(&f.dir, f.dir.join("recovery.json")).unwrap();
    let b = restored
        .request("buffer.get", json!({"path":"note.txt"}))
        .unwrap();
    assert_eq!(b["text"], "unsaved");
    assert_eq!(b["version"], 2);
    let b = restored
        .request("buffer.undo", json!({"path":"note.txt","version":2}))
        .unwrap();
    assert_eq!(b["text"], "original\n");
    let b = restored
        .request("buffer.redo", json!({"path":"note.txt","version":3}))
        .unwrap();
    assert_eq!(b["text"], "unsaved");
    restored
        .request("buffer.save", json!({"path":"note.txt","version":4}))
        .unwrap();
    assert_eq!(
        fs::read_to_string(f.dir.join("note.txt")).unwrap(),
        "unsaved"
    );
}
#[test]
fn bounds_and_explicit_mutation_approval() {
    let f = Fixture::new();
    f.call("buffer.open", json!({"path":"note.txt"}));
    assert!(f
        .service
        .request(
            "buffer.edit",
            json!({"path":"note.txt","version":1,"text":"x".repeat(MAX_TEXT+1)})
        )
        .is_err());
    assert!(f
        .service
        .request("git.stage", json!({"path":"note.txt"}))
        .is_err());
    assert!(f
        .service
        .request("language.start", json!({"name":"test"}))
        .is_err());
    assert!(f
        .service
        .request("debug.start", json!({"name":"test"}))
        .is_err());
    assert!(f.service.request("not-a-method", json!({})).is_err());
    fs::write(f.dir.join(".afteredit.json"),r#"{"tasks":{"a":{"command":"echo","args":["${project}"],"dependsOn":["b"]},"b":{"command":"true"}}}"#).unwrap();
    let plan = f.call("task.plan", json!({"name":"a"}));
    assert_eq!(plan["tasks"][0][0], "b");
    assert_eq!(
        plan["tasks"][1][1]["args"][0],
        f.dir.canonicalize().unwrap().to_string_lossy().as_ref()
    );
    assert!(f
        .service
        .request("task.run", json!({"name":"a","approval":"outdated"}))
        .is_err());
}
#[test]
fn create_never_overwrites_and_paths_stay_in_workspace() {
    let f = Fixture::new();
    f.call("buffer.create", json!({"path":"new.txt"}));
    assert!(f
        .service
        .request("buffer.create", json!({"path":"note.txt"}))
        .is_err());
    assert!(f
        .service
        .request("buffer.create", json!({"path":"../escape.txt"}))
        .is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("/etc/hosts", f.dir.join("escape")).unwrap();
        assert!(f
            .service
            .request("buffer.open", json!({"path":"escape"}))
            .is_err());
    }
    assert_eq!(
        fs::read_to_string(f.dir.join("note.txt")).unwrap(),
        "original\n"
    );
}
#[test]
fn plain_editor_preserves_line_endings_and_rejects_invalid_lines() {
    assert_eq!(
        cli::edit_lines("one\r\ntwo\r\n", "replace", "2 changed").unwrap(),
        "one\r\nchanged\r\n"
    );
    assert_eq!(
        cli::edit_lines("one\ntwo", "replace", "1 changed").unwrap(),
        "changed\ntwo"
    );
    assert!(cli::edit_lines("one", "delete", "0").is_err());
    assert_eq!(cli::spoken("safe\x1b[2J"), "safe\\u{1b}[2J");
}
