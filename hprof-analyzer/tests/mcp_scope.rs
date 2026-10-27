//! Real local stdio boundary tests. No AI provider, personal dump or credentials.
use serde_json::{json,Value};
use std::{io::{BufRead,BufReader,Write},process::{Child,ChildStdin,Command,Stdio},sync::{Arc,Mutex,mpsc},time::Duration};
struct Server{child:Child,input:ChildStdin,output:mpsc::Receiver<Value>,pending:Vec<Value>,errors:Arc<Mutex<String>>}
impl Drop for Server{fn drop(&mut self){let _=self.child.kill();let _=self.child.wait();}}
impl Server{
    fn new(args:&[&str])->Self{let mut child=Command::new(env!("CARGO_BIN_EXE_hprof-server")).arg("--mcp").args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();let input=child.stdin.take().unwrap();let stdout=child.stdout.take().unwrap();let stderr=child.stderr.take().unwrap();let(tx,output)=mpsc::channel();let errors=Arc::new(Mutex::new(String::new()));let saved=errors.clone();
        std::thread::spawn(move||for line in BufReader::new(stdout).lines().map_while(Result::ok){if let Ok(value)=serde_json::from_str(&line){if tx.send(value).is_err(){break;}}});
        std::thread::spawn(move||for line in BufReader::new(stderr).lines().map_while(Result::ok){saved.lock().unwrap().push_str(&line);});
        Self{child,input,output,pending:vec![],errors}}
    fn send(&mut self,value:Value){writeln!(self.input,"{value}").unwrap();self.input.flush().unwrap();}
    fn call(&mut self,id:u64,name:&str,args:Value){self.send(json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":args}}));}
    fn ack(&mut self,id:u64)->Value{if let Some(i)=self.pending.iter().position(|v|v["id"]==id){return self.pending.remove(i);}loop{let value=self.output.recv_timeout(Duration::from_secs(15)).expect("MCP response");if value["id"]==id{return value;}self.pending.push(value);}}
    fn data(&mut self,id:u64)->Value{let response=self.ack(id);assert_eq!(response["result"]["isError"],false,"{response}");serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap()}
}
fn fixture(id:u64)->Vec<u8>{let mut data=b"JAVA PROFILE 1.0.2\0".to_vec();data.extend(8u32.to_be_bytes());data.extend(0u64.to_be_bytes());let mut heap=vec![0xff];heap.extend(id.to_be_bytes());heap.push(0x23);heap.extend(id.to_be_bytes());heap.extend(0u32.to_be_bytes());heap.extend(13u32.to_be_bytes());heap.push(8);heap.extend(b"SECRET_CANARY");data.push(0x1c);data.extend(0u32.to_be_bytes());data.extend((heap.len()as u32).to_be_bytes());data.extend(heap);data.push(0x2c);data.extend([0;8]);data}
#[test]fn launch_requires_both_exact_files_and_metadata_grant_and_denies_direct_legacy_calls(){
    let dir=tempfile::tempdir().unwrap();let path=dir.path().join("SECRET_PATH.hprof");std::fs::write(&path,fixture(512)).unwrap();
    for args in [vec![],vec!["--mcp-allow-file",path.to_str().unwrap()],vec!["--mcp-share-metadata"]]{let mut s=Server::new(&args);
        s.send(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}));let list=s.ack(1);assert_eq!(list["result"]["tools"].as_array().unwrap().len(),6);assert!(!list.to_string().contains("execute_query"));
        for (id,name,args) in [(2,"analyze_heap",json!({"path":path})),(3,"execute_query",json!({"query":"SELECT SECRET_CANARY"})),(5,"inspect_object",json!({"path":path,"object_id":512}))]{s.call(id,name,args);let result=s.ack(id);assert_eq!(result["result"]["isError"],true);assert!(!result.to_string().contains("SECRET_"));}
        s.call(4,"list_dumps",json!({}));if args.contains(&"--mcp-share-metadata"){assert_eq!(s.data(4)["dumps"],json!([]));}else{assert_eq!(s.ack(4)["result"]["isError"],true);}
        assert!(!s.errors.lock().unwrap().contains("SECRET_"));}
}
#[test]fn approved_aliases_exact_ids_evidence_generations_and_no_raw_values(){
    let dir=tempfile::tempdir().unwrap();let path=dir.path().join("SECRET_PATH.hprof");std::fs::write(&path,fixture(u64::MAX)).unwrap();let mut s=Server::new(&["--mcp-share-metadata","--mcp-allow-file",path.to_str().unwrap()]);
    s.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}));assert_eq!(s.ack(1)["result"]["protocolVersion"],"2025-11-25");
    s.call(2,"list_dumps",json!({}));assert_eq!(s.data(2)["dumps"],json!([{"dump_id":"dump_1"}]));
    s.call(3,"analyze_heap",json!({"dump_id":"dump_1"}));let full=s.data(3);let generation=full["analysis_id"].clone();assert!(!full.to_string().contains("SECRET_"));assert_eq!(full["evidence"]["data"]["rows"][0]["object_id"],u64::MAX.to_string());
    s.call(4,"investigate_heap",json!({"dump_id":"dump_1","analysis_id":generation,"action":{"operation":"object","object_id":u64::MAX.to_string()}}));let evidence=s.data(4);assert_eq!(evidence["evidence"]["data"]["selected"]["object_id"],u64::MAX.to_string());assert!(!evidence.to_string().contains("SECRET_"));let handle=evidence["evidence"]["id"].clone();
    s.call(5,"get_evidence",json!({"dump_id":"dump_1","analysis_id":generation,"evidence_id":handle}));assert_eq!(s.data(5),evidence["evidence"]);
    s.call(6,"analyze_heap",json!({"dump_id":"dump_1"}));assert_ne!(s.data(6)["analysis_id"],generation);
    s.call(7,"get_evidence",json!({"dump_id":"dump_1","analysis_id":generation,"evidence_id":handle}));assert_eq!(s.ack(7)["result"]["isError"],true);
    for (id,action) in [(8,json!({"operation":"fields","object_id":u64::MAX})),(9,json!({"operation":"object","object_id":"1","include_values":true})),(10,json!({"operation":"execute_query","object_id":"1"}))]{s.call(id,"investigate_heap",json!({"dump_id":"dump_1","analysis_id":"A2","action":action}));assert_eq!(s.ack(id)["result"]["isError"],true);}
    s.call(11,"close_dump",json!({"dump_id":"dump_1","analysis_id":"A2"}));assert_eq!(s.data(11)["closed"],true);s.call(12,"get_summary",json!({"dump_id":"dump_1","analysis_id":"A2"}));assert_eq!(s.ack(12)["result"]["isError"],true);
    assert!(!s.errors.lock().unwrap().contains("SECRET_"));
}
#[test]fn approved_file_replacement_and_modified_contents_are_rejected(){
    let dir=tempfile::tempdir().unwrap();let path=dir.path().join("approved.hprof");std::fs::write(&path,fixture(512)).unwrap();let mut s=Server::new(&["--mcp-share-metadata","--mcp-allow-file",path.to_str().unwrap()]);
    s.call(1,"list_dumps",json!({}));s.data(1);let replacement=dir.path().join("other");std::fs::write(&replacement,fixture(513)).unwrap();std::fs::rename(replacement,&path).unwrap();
    s.call(2,"analyze_heap",json!({"dump_id":"dump_1"}));assert_eq!(s.ack(2)["result"]["isError"],true);
}
#[test]fn queued_cancel_is_targeted_and_ping_remains_responsive(){
    let dir=tempfile::tempdir().unwrap();let path=dir.path().join("approved.hprof");std::fs::write(&path,fixture(512)).unwrap();let mut s=Server::new(&["--mcp-share-metadata","--mcp-allow-file",path.to_str().unwrap()]);
    let batch=[json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"analyze_heap","arguments":{"dump_id":"dump_1"}}}),json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1,"reason":"SECRET_REASON"}}),json!({"jsonrpc":"2.0","id":2,"method":"ping"})].into_iter().map(|v|v.to_string()+"\n").collect::<String>();s.input.write_all(batch.as_bytes()).unwrap();s.input.flush().unwrap();assert!(s.ack(2)["result"].is_object());
    s.call(3,"analyze_heap",json!({"dump_id":"dump_1"}));s.data(3);assert!(s.pending.iter().all(|v|v["id"]!=1));
    s.call(3,"analyze_heap",json!({"dump_id":"dump_1"}));assert_eq!(s.ack(3)["result"]["isError"],true);assert!(!s.errors.lock().unwrap().contains("SECRET_"));
}
#[test]fn malformed_and_oversized_frames_never_echo_secrets(){
    let mut s=Server::new(&[]);writeln!(s.input,"{{SECRET_CANARY").unwrap();s.input.flush().unwrap();s.send(json!({"jsonrpc":"2.0","id":1,"method":"ping"}));assert!(s.ack(1)["result"].is_object());
    writeln!(s.input,"{}SECRET_CANARY","x".repeat(65537)).unwrap();s.input.flush().unwrap();let start=std::time::Instant::now();while s.child.try_wait().unwrap().is_none()&&start.elapsed()<Duration::from_secs(3){std::thread::sleep(Duration::from_millis(10));}assert!(s.child.try_wait().unwrap().is_some());assert!(!s.errors.lock().unwrap().contains("SECRET_"));
}
#[test]fn mcp_memory_disk_build_and_disk_reuse_return_identical_metadata(){
    let dir=tempfile::tempdir().unwrap();let path=dir.path().join("approved.hprof");let cache=dir.path().join("cache");std::fs::write(&path,fixture(512)).unwrap();let mut baseline=None;
    for mode in ["memory","disk","disk"]{let mut s=Server::new(&["--mcp-share-metadata","--mcp-allow-file",path.to_str().unwrap(),"--storage",mode,"--cache-dir",cache.to_str().unwrap(),"--edge-buffer-mib","1"]);s.call(1,"analyze_heap",json!({"dump_id":"dump_1"}));let data=s.data(1)["evidence"]["data"].clone();if let Some(expected)=&baseline{assert_eq!(&data,expected);}else{baseline=Some(data);}}
}
#[cfg(unix)]#[test]fn symlink_launch_approval_is_rejected_without_echoing_path(){
    let dir=tempfile::tempdir().unwrap();let path=dir.path().join("SECRET_PATH.hprof");let link=dir.path().join("SECRET_LINK.hprof");std::fs::write(&path,fixture(512)).unwrap();std::os::unix::fs::symlink(&path,&link).unwrap();
    let result=Command::new(env!("CARGO_BIN_EXE_hprof-server")).args(["--mcp","--mcp-share-metadata","--mcp-allow-file",link.to_str().unwrap()]).output().unwrap();assert!(!result.status.success());assert!(!String::from_utf8_lossy(&result.stderr).contains("SECRET_"));
}
