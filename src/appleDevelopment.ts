export const swiftSnippets=[
 {label:'SwiftUI View',body:'import SwiftUI\n\nstruct ${1:ContentView}: View {\n\tvar body: some View {\n\t\tText("${2:Hello}")\n\t}\n}'},
 {label:'SwiftUI preview',body:'#Preview {\n\t${1:ContentView}()\n}'},
 {label:'XCTest case',body:'func test${1:Behavior}() throws {\n\tXCTAssertEqual(${2:actual}, ${3:expected})\n}'},
 {label:'Swift async function',body:'func ${1:load}() async throws -> ${2:String} {\n\t$0\n}'},
];
