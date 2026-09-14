//! Optional visual terminal surface. Plain mode is the accessible default.
use super::{
    cli::{spoken, Client},
    *,
};
use std::io::{self, IsTerminal, Read, Write};
#[cfg(unix)]
struct Raw(libc::termios);
#[cfg(unix)]
impl Raw {
    fn enter() -> Result<Self, String> {
        unsafe {
            let mut original = std::mem::zeroed();
            if libc::tcgetattr(0, &mut original) != 0 {
                return Err("Cannot read terminal settings".into());
            }
            let mut raw = original;
            libc::cfmakeraw(&mut raw);
            raw.c_cc[libc::VMIN] = 1;
            raw.c_cc[libc::VTIME] = 0;
            if libc::tcsetattr(0, libc::TCSAFLUSH, &raw) != 0 {
                return Err("Cannot enter terminal mode".into());
            }
            Ok(Self(original))
        }
    }
}
#[cfg(unix)]
impl Drop for Raw {
    fn drop(&mut self) {
        unsafe {
            libc::tcsetattr(0, libc::TCSAFLUSH, &self.0);
        }
        print!("\x1b[?2004l\x1b[?1049l");
        let _ = io::stdout().flush();
    }
}
#[cfg(not(unix))]
pub fn run(_client: Client, _path: Option<String>) -> Result<(), String> {
    Err("Visual terminal prototype supports macOS/Linux; use --plain".into())
}
#[cfg(unix)]
pub fn run(client: Client, path: Option<String>) -> Result<(), String> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(
            "Visual mode needs a terminal. Use --plain for screen readers and pipes.".into(),
        );
    }
    let path = path.ok_or("Visual mode needs a file path; use --plain to browse a workspace")?;
    let mut buffer = client.call("buffer.open", json!({"path":path}))?;
    let mut value = buffer["text"]
        .as_str()
        .unwrap_or("")
        .chars()
        .collect::<Vec<_>>();
    let mut cursor = 0usize;
    let mut message = "Type to insert. Ctrl-P: commands; Ctrl-S: save; Ctrl-Q: leave.".to_string();
    let _raw = Raw::enter()?;
    print!("\x1b[?1049h\x1b[?2004h");
    let mut input = io::stdin();
    let mut leave = false;
    loop {
        let (width, height) = size();
        let line = value[..cursor].iter().filter(|c| **c == '\n').count();
        let start_line = line.saturating_sub(height.saturating_sub(5));
        let text = value.iter().collect::<String>();
        print!(
            "\x1b[H\x1b[2J{} · rev {}\r\n",
            clip(&spoken(&path), width.saturating_sub(15)),
            buffer["version"]
        );
        for (n, row) in text
            .split('\n')
            .enumerate()
            .skip(start_line)
            .take(height.saturating_sub(4))
        {
            print!(
                "{:>4} {}\r\n",
                n + 1,
                clip(&spoken(row), width.saturating_sub(6))
            );
        }
        print!(
            "\x1b[{};1H{}\x1b[K\x1b[{};1HCtrl-S Save | Ctrl-P Commands | Ctrl-Q Leave\x1b[K",
            height - 1,
            clip(&spoken(&message), width),
            height
        );
        let column = value[..cursor]
            .iter()
            .rev()
            .take_while(|c| **c != '\n')
            .count();
        print!(
            "\x1b[{};{}H",
            line - start_line + 2,
            (column + 6).min(width)
        );
        io::stdout().flush().map_err(err)?;
        let mut byte = [0u8];
        if input.read(&mut byte).map_err(err)? == 0 {
            publish(&client, &mut buffer, &value)?;
            break;
        }
        let action = (|| -> Result<(), String> {
            match byte[0] {
                17 => {
                    message = "Leaving: shared drafts remain recoverable on the server.".into();
                    return Ok(());
                }
                19 => {
                    publish(&client, &mut buffer, &value)?;
                    buffer = client.call(
                        "buffer.save",
                        json!({"path":path,"version":buffer["version"]}),
                    )?;
                    message = "Saved".into();
                }
                16 => {
                    let command=prompt("Command: help, refresh, undo, redo, find TEXT, line N, diagnostics, symbols QUERY",&mut input,height)?;
                    match command.as_str(){"leave without publishing"=>{leave=true;},_ if command.starts_with("export ")=>{let target=Path::new(&command[7..]);let mut options=fs::OpenOptions::new();options.write(true).create_new(true);use std::os::unix::fs::OpenOptionsExt;let mut file=options.mode(0o600).open(target).map_err(err)?;file.write_all(value.iter().collect::<String>().as_bytes()).map_err(err)?;file.sync_all().map_err(err)?;message="Local recovery copy exported. Use refresh after publishing, or leave without publishing.".into();},"help"=>message="No modes: type text; arrows move; Backspace deletes; Ctrl-S saves; Ctrl-Q leaves; Ctrl-P: export PATH saves a new local recovery file; leave without publishing explicitly discards local changes.".into(),"refresh"=>{if value.iter().collect::<String>()!=buffer["text"].as_str().unwrap_or(""){return Err("Save or publish this local draft before refresh".into());}buffer=client.call("buffer.get",json!({"path":path}))?;value=buffer["text"].as_str().unwrap_or("").chars().collect();cursor=cursor.min(value.len());message="Fetched current shared buffer".into();},"undo"|"redo"=>{publish(&client,&mut buffer,&value)?;buffer=client.call(&format!("buffer.{command}"),json!({"path":path,"version":buffer["version"]}))?;value=buffer["text"].as_str().unwrap_or("").chars().collect();cursor=cursor.min(value.len());},"diagnostics"=>message=client.call("diagnostics",json!({}))?.to_string(),_ if command.starts_with("find ")=>{let query=&command[5..];let text=value.iter().collect::<String>();if let Some(index)=text.find(query){cursor=text[..index].chars().count();message="Match found".into();}else{message="No match".into();}},_ if command.starts_with("line ")=>{let wanted=command[5..].parse::<usize>().map_err(err)?;cursor=0;let mut current=1;while cursor<value.len()&&current<wanted{if value[cursor]=='\n'{current+=1;}cursor+=1;}},_ if command.starts_with("symbols ")=>message=client.call("symbols",json!({"query":&command[8..]}))?.to_string(),_=>message="Unknown command; Ctrl-P then help".into()}
                }
                26 | 25 => {
                    publish(&client, &mut buffer, &value)?;
                    buffer = client.call(
                        if byte[0] == 26 {
                            "buffer.undo"
                        } else {
                            "buffer.redo"
                        },
                        json!({"path":path,"version":buffer["version"]}),
                    )?;
                    value = buffer["text"].as_str().unwrap_or("").chars().collect();
                    cursor = cursor.min(value.len());
                }
                127 | 8 => {
                    if cursor > 0 {
                        cursor -= 1;
                        value.remove(cursor);
                    }
                }
                13 | 10 => {
                    value.insert(cursor, '\n');
                    cursor += 1;
                }
                9 => {
                    value.insert(cursor, '\t');
                    cursor += 1;
                }
                27 => {
                    let sequence = escape(&mut input)?;
                    match sequence.as_str() {
                        "[D" => cursor = cursor.saturating_sub(1),
                        "[C" => cursor = (cursor + 1).min(value.len()),
                        "[A" => {
                            let column = value[..cursor]
                                .iter()
                                .rev()
                                .take_while(|c| **c != '\n')
                                .count();
                            let start = cursor - column;
                            if start > 0 {
                                let previous = value[..start - 1]
                                    .iter()
                                    .rposition(|c| *c == '\n')
                                    .map(|n| n + 1)
                                    .unwrap_or(0);
                                cursor = previous + column.min(start - 1 - previous);
                            }
                        }
                        "[B" => {
                            let column = value[..cursor]
                                .iter()
                                .rev()
                                .take_while(|c| **c != '\n')
                                .count();
                            if let Some(end) = value[cursor..].iter().position(|c| *c == '\n') {
                                let next = cursor + end + 1;
                                let length = value[next..]
                                    .iter()
                                    .position(|c| *c == '\n')
                                    .unwrap_or(value.len() - next);
                                cursor = next + column.min(length);
                            }
                        }
                        "[200~" => {
                            let mut paste = Vec::new();
                            while paste.len() < MAX_TEXT {
                                let mut b = [0];
                                input.read_exact(&mut b).map_err(err)?;
                                paste.push(b[0]);
                                if paste.ends_with(b"\x1b[201~") {
                                    paste.truncate(paste.len() - 6);
                                    break;
                                }
                            }
                            let paste = String::from_utf8(paste).map_err(err)?;
                            for c in paste
                                .chars()
                                .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
                            {
                                value.insert(cursor, c);
                                cursor += 1;
                            }
                        }
                        _ => {}
                    }
                }
                b if b >= 32 => {
                    let mut bytes = vec![b];
                    let length = if b < 128 {
                        1
                    } else if b & 0xe0 == 0xc0 {
                        2
                    } else if b & 0xf0 == 0xe0 {
                        3
                    } else {
                        4
                    };
                    for _ in 1..length {
                        let mut b = [0];
                        input.read_exact(&mut b).map_err(err)?;
                        bytes.push(b[0]);
                    }
                    for c in String::from_utf8(bytes).map_err(err)?.chars() {
                        value.insert(cursor, c);
                        cursor += 1;
                    }
                }
                _ => {}
            }
            Ok(())
        })();
        if let Err(e) = action {
            message = e;
        }
        if leave {
            break;
        }
        if byte[0] == 17 {
            match publish(&client, &mut buffer, &value) {
                Ok(()) => break,
                Err(e) => {
                    message=format!("{e}. Local text retained. Ctrl-P export PATH saves a copy; leave without publishing exits explicitly.");
                }
            }
        }
        if value.len() > MAX_TEXT {
            message = "Buffer limit reached; remove text before saving".into();
        }
    }
    Ok(())
}
fn publish(client: &Client, buffer: &mut Value, value: &[char]) -> Result<(), String> {
    let text = value.iter().collect::<String>();
    if buffer["text"] != text {
        *buffer = client.call(
            "buffer.edit",
            json!({"path":buffer["path"],"version":buffer["version"],"text":text}),
        )?;
    }
    Ok(())
}
#[cfg(unix)]
fn size() -> (usize, usize) {
    unsafe {
        let mut s: libc::winsize = std::mem::zeroed();
        libc::ioctl(1, libc::TIOCGWINSZ, &mut s);
        ((s.ws_col as usize).max(30), (s.ws_row as usize).max(8))
    }
}
#[cfg(unix)]
fn escape(input: &mut impl Read) -> Result<String, String> {
    let mut bytes = vec![];
    for _ in 0..12 {
        let mut poll = libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        };
        if unsafe { libc::poll(&mut poll, 1, 40) } <= 0 {
            break;
        }
        let mut b = [0];
        input.read_exact(&mut b).map_err(err)?;
        bytes.push(b[0]);
        if b[0].is_ascii_alphabetic() || b[0] == b'~' {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into())
}
#[cfg(unix)]
fn prompt(label: &str, input: &mut impl Read, height: usize) -> Result<String, String> {
    let mut value = String::new();
    loop {
        print!("\x1b[{};1H{}: {}\x1b[K", height - 1, label, spoken(&value));
        io::stdout().flush().map_err(err)?;
        let mut byte = [0];
        input.read_exact(&mut byte).map_err(err)?;
        match byte[0] {
            13 | 10 => return Ok(value),
            27 => return Ok(String::new()),
            127 | 8 => {
                value.pop();
            }
            b if (32..127).contains(&b) && value.len() < 2000 => value.push(b as char),
            _ => {}
        }
    }
}
fn clip(text: &str, width: usize) -> String {
    text.chars().take(width).collect()
}
