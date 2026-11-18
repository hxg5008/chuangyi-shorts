package protocol

import (
 "encoding/json"
 "os"
 "path/filepath"
 "testing"
)
// Upstream fixture helpers, with only the fixture root relocated into this module.
func officialPackageAdapter(t *testing.T, packageName, providerID string) Adapter {
 t.Helper();data,err:=os.ReadFile(filepath.Join("..","..","testdata","plugin-packages",packageName));if err!=nil{t.Fatal(err)}
 pkg,err:=ParsePluginPackage(data);if err!=nil{t.Fatal(err)};adapters,err:=LoadInstalledProviders(pkg.ManifestRaw,nil);if err!=nil{t.Fatal(err)}
 for _,adapter:=range adapters{if adapter.Metadata().ID==providerID{return adapter}}
 t.Fatalf("provider %s is missing from %s",providerID,packageName);return nil
}
func manifestTestBody(t *testing.T,spec RequestSpec)map[string]any{t.Helper();data,err:=json.Marshal(spec.Body);if err!=nil{t.Fatal(err)};var body map[string]any;if err:=json.Unmarshal(data,&body);err!=nil{t.Fatal(err)};return body}
