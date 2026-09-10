// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "AfterEditAppleFixture", products: [
    .executable(name: "AppleSmoke", targets: ["AppleSmoke"])
], targets: [
    .target(name: "SampleCore"),
    .executableTarget(name: "AppleSmoke", dependencies: ["SampleCore"]),
    .testTarget(name: "SampleCoreTests", dependencies: ["SampleCore"])
])
