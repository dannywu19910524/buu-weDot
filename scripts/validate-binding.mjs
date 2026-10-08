import {privateFile} from '../src/private-files.mjs';
import {validateBinding} from '../src/store.mjs';
try{const i=process.argv.indexOf('--file');if(i<0||!process.argv[i+1])throw 0;const binding=validateBinding(JSON.parse(privateFile(process.argv[i+1])));console.log(JSON.stringify({valid:true,send_consent:binding.consent.send,network_calls:0}));}catch{console.error('Binding rejected; provide --file PRIVATE_BINDING with owner-only permissions and the documented fields.');process.exitCode=1;}
