import test from 'node:test'
import assert from 'node:assert/strict'
import {episodeDisplayTitle} from '../app/utils/episode-title.js'
test('matching episode heading is removed only for display',()=>{for(const [title,n,expected]of [['第1集｜吹来的真车',1,'吹来的真车'],['第 02 集 · 卖声的代价',2,'卖声的代价'],['第三集：故事',3,'故事'],['第二十集 结尾',20,'结尾'],['EP01 — Story',1,'Story'],['第1集',1,'']])assert.equal(episodeDisplayTitle(title,n),expected)})
test('different source numbering and ordinary titles stay intact',()=>{for(const [title,n]of [['第2集｜原文第二集',1],['故事里的第1集',1],['第1集的秘密',1],['第十章 小说',10]])assert.equal(episodeDisplayTitle(title,n),title)})
