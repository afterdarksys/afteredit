use std::{io::Read, process::{Command, Stdio}, time::{Duration, Instant}};
pub(crate) struct Output { pub code:i32, pub stdout:String, pub stderr:String }
pub(crate) fn run(mut command:Command, timeout:Duration) -> Result<Output,String> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)] {use std::os::unix::process::CommandExt;command.process_group(0);}
    let mut child=command.spawn().map_err(|e|format!("Could not start tool: {e}"))?;
    fn read(input:impl Read+Send+'static)->std::thread::JoinHandle<Result<String,String>> {
        std::thread::spawn(move|| {
            let mut bytes=Vec::new();
            input.take(2_000_001).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
            if bytes.len()>2_000_000{return Err("Tool output exceeds 2 MB; narrow the operation.".into());}
            String::from_utf8(bytes).map_err(|_|"Tool output contains non-UTF-8 text.".into())
        })
    }
    let out=read(child.stdout.take().unwrap());let err=read(child.stderr.take().unwrap());
    let start=Instant::now();
    let result=loop {
        match child.try_wait(){Ok(Some(status))=>break Ok(status.code().unwrap_or(-1)),Err(e)=>break Err(e.to_string()),_=>{}}
        if start.elapsed()>timeout{break Err("Tool timed out.".into());}
        std::thread::sleep(Duration::from_millis(20));
    };
    #[cfg(unix)] unsafe {libc::kill(-(child.id() as i32),libc::SIGKILL);}
    if result.is_err(){let _=child.kill();}
    let _=child.wait();
    let stdout=out.join().map_err(|_|"Output reader failed")??;
    let stderr=err.join().map_err(|_|"Error reader failed")??;
    Ok(Output{code:result?,stdout,stderr})
}
