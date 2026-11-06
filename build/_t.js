const fs=require('node:fs');
fs.writeFileSync('D:/HMCL-PE重构QCL计划/qcl-pc/.cache/boot3.txt','OK argv='+JSON.stringify(process.argv.slice(1,4)));
process.exit(0);
