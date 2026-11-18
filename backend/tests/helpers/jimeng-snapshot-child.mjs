import path from 'node:path'
const root=process.env.HUOBAO_DATA_DIR
if(!root||!path.basename(root).startsWith('jimeng-snapshot-atomic-'))throw new Error('Isolated snapshot fixture required')
const {freezeJimengReferences,prepareJimengVideoRecord}=await import('../../src/services/jimeng-local-media.ts')
const record={id:1,model:'jimeng-2.0-fast',prompt:'@人物 转身。',referenceImageUrls:JSON.stringify(['static/images/shared.png']),referenceImageNames:JSON.stringify(['人物']),duration:5,aspectRatio:'16:9'}
const snapshots=await freezeJimengReferences(record),prepared=await prepareJimengVideoRecord(record,snapshots)
console.log(JSON.stringify({sha256:snapshots[0].sha256,bytes:Buffer.from(prepared.jimengImages[0].data_base64,'base64').length}))
