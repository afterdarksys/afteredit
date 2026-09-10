import XCTest
@testable import SampleCore
final class AnswerTests: XCTestCase {
    func testAnswer() { XCTAssertEqual(answer(), 42) }
}
